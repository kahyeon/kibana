/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */
import moment from 'moment';

import { AlertServices } from '../../../../../alerts/server';
import { ListClient } from '../../../../../lists/server';
import { RuleAlertAction } from '../../../../common/detection_engine/types';
import { RuleTypeParams, RefreshTypes } from '../types';
import { Logger } from '../../../../../../../src/core/server';
import { singleSearchAfter } from './single_search_after';
import { singleBulkCreate } from './single_bulk_create';
import { BuildRuleMessage } from './rule_messages';
import { SignalSearchResponse } from './types';
import { filterEventsAgainstList } from './filter_events_with_list';
import { ExceptionListItemSchema } from '../../../../../lists/common/schemas';
import { getSignalTimeTuples } from './utils';

interface SearchAfterAndBulkCreateParams {
  gap: moment.Duration | null;
  previousStartedAt: Date | null | undefined;
  ruleParams: RuleTypeParams;
  services: AlertServices;
  listClient: ListClient;
  exceptionsList: ExceptionListItemSchema[];
  logger: Logger;
  id: string;
  inputIndexPattern: string[];
  signalsIndex: string;
  name: string;
  actions: RuleAlertAction[];
  createdAt: string;
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
  interval: string;
  enabled: boolean;
  pageSize: number;
  filter: unknown;
  refresh: RefreshTypes;
  tags: string[];
  throttle: string;
  buildRuleMessage: BuildRuleMessage;
}

export interface SearchAfterAndBulkCreateReturnType {
  success: boolean;
  searchAfterTimes: string[];
  bulkCreateTimes: string[];
  lastLookBackDate: Date | null | undefined;
  createdSignalsCount: number;
  errors: string[];
}

// search_after through documents and re-index using bulk endpoint.
export const searchAfterAndBulkCreate = async ({
  gap,
  previousStartedAt,
  ruleParams,
  exceptionsList,
  services,
  listClient,
  logger,
  id,
  inputIndexPattern,
  signalsIndex,
  filter,
  actions,
  name,
  createdAt,
  createdBy,
  updatedBy,
  updatedAt,
  interval,
  enabled,
  pageSize,
  refresh,
  tags,
  throttle,
  buildRuleMessage,
}: SearchAfterAndBulkCreateParams): Promise<SearchAfterAndBulkCreateReturnType> => {
  const toReturn: SearchAfterAndBulkCreateReturnType = {
    success: true,
    searchAfterTimes: [],
    bulkCreateTimes: [],
    lastLookBackDate: null,
    createdSignalsCount: 0,
    errors: [],
  };

  // sortId tells us where to start our next consecutive search_after query
  let sortId: string | undefined;

  // signalsCreatedCount keeps track of how many signals we have created,
  // to ensure we don't exceed maxSignals
  let signalsCreatedCount = 0;

  const totalToFromTuples = getSignalTimeTuples({
    logger,
    ruleParamsFrom: ruleParams.from,
    ruleParamsTo: ruleParams.to,
    ruleParamsMaxSignals: ruleParams.maxSignals,
    gap,
    previousStartedAt,
    interval,
    buildRuleMessage,
  });
  logger.debug(buildRuleMessage(`totalToFromTuples: ${totalToFromTuples.length}`));
  while (totalToFromTuples.length > 0) {
    const tuple = totalToFromTuples.pop();
    if (tuple == null || tuple.to == null || tuple.from == null) {
      logger.error(buildRuleMessage(`[-] malformed date tuple`));
      toReturn.success = false;
      toReturn.errors = [...new Set([...toReturn.errors, 'malformed date tuple'])];
      return toReturn;
    }
    signalsCreatedCount = 0;
    while (signalsCreatedCount < tuple.maxSignals) {
      try {
        logger.debug(buildRuleMessage(`sortIds: ${sortId}`));

        // perform search_after with optionally undefined sortId
        const {
          searchResult,
          searchDuration,
        }: { searchResult: SignalSearchResponse; searchDuration: string } = await singleSearchAfter(
          {
            searchAfterSortId: sortId,
            index: inputIndexPattern,
            from: tuple.from.toISOString(),
            to: tuple.to.toISOString(),
            services,
            logger,
            filter,
            pageSize: tuple.maxSignals < pageSize ? Math.ceil(tuple.maxSignals) : pageSize, // maximum number of docs to receive per search result.
            timestampOverride: ruleParams.timestampOverride,
          }
        );
        toReturn.searchAfterTimes.push(searchDuration);

        // determine if there are any candidate signals to be processed
        const totalHits =
          typeof searchResult.hits.total === 'number'
            ? searchResult.hits.total
            : searchResult.hits.total.value;
        logger.debug(buildRuleMessage(`totalHits: ${totalHits}`));
        logger.debug(
          buildRuleMessage(`searchResult.hit.hits.length: ${searchResult.hits.hits.length}`)
        );

        // search results yielded zero hits so exit
        // with search_after, these two values can be different when
        // searching with the last sortId of a consecutive search_after
        // yields zero hits, but there were hits using the previous
        // sortIds.
        // e.g. totalHits was 156, index 50 of 100 results, do another search-after
        // this time with a new sortId, index 22 of the remaining 56, get another sortId
        // search with that sortId, total is still 156 but the hits.hits array is empty.
        if (totalHits === 0 || searchResult.hits.hits.length === 0) {
          logger.debug(
            buildRuleMessage(
              `${
                totalHits === 0 ? 'totalHits' : 'searchResult.hits.hits.length'
              } was 0, exiting and moving on to next tuple`
            )
          );
          break;
        }
        toReturn.lastLookBackDate =
          searchResult.hits.hits.length > 0
            ? new Date(
                searchResult.hits.hits[searchResult.hits.hits.length - 1]?._source['@timestamp']
              )
            : null;

        // filter out the search results that match with the values found in the list.
        // the resulting set are signals to be indexed, given they are not duplicates
        // of signals already present in the signals index.
        const filteredEvents: SignalSearchResponse = await filterEventsAgainstList({
          listClient,
          exceptionsList,
          logger,
          eventSearchResult: searchResult,
          buildRuleMessage,
        });

        // only bulk create if there are filteredEvents leftover
        // if there isn't anything after going through the value list filter
        // skip the call to bulk create and proceed to the next search_after,
        // if there is a sort id to continue the search_after with.
        if (filteredEvents.hits.hits.length !== 0) {
          // make sure we are not going to create more signals than maxSignals allows
          if (signalsCreatedCount + filteredEvents.hits.hits.length > tuple.maxSignals) {
            filteredEvents.hits.hits = filteredEvents.hits.hits.slice(
              0,
              tuple.maxSignals - signalsCreatedCount
            );
          }
          const {
            bulkCreateDuration: bulkDuration,
            createdItemsCount: createdCount,
            success: bulkSuccess,
            errors: bulkErrors,
          } = await singleBulkCreate({
            filteredEvents,
            ruleParams,
            services,
            logger,
            id,
            signalsIndex,
            actions,
            name,
            createdAt,
            createdBy,
            updatedAt,
            updatedBy,
            interval,
            enabled,
            refresh,
            tags,
            throttle,
          });
          logger.debug(buildRuleMessage(`created ${createdCount} signals`));
          toReturn.createdSignalsCount += createdCount;
          signalsCreatedCount += createdCount;
          logger.debug(buildRuleMessage(`signalsCreatedCount: ${signalsCreatedCount}`));
          if (bulkDuration) {
            toReturn.bulkCreateTimes.push(bulkDuration);
          }

          logger.debug(
            buildRuleMessage(`filteredEvents.hits.hits: ${filteredEvents.hits.hits.length}`)
          );
          toReturn.success = toReturn.success && bulkSuccess;
          toReturn.errors = [...new Set([...toReturn.errors, ...bulkErrors])];
        }

        // we are guaranteed to have searchResult hits at this point
        // because we check before if the totalHits or
        // searchResult.hits.hits.length is 0
        const lastSortId = searchResult.hits.hits[searchResult.hits.hits.length - 1].sort;
        if (lastSortId != null && lastSortId.length !== 0) {
          sortId = lastSortId[0];
        } else {
          logger.debug(buildRuleMessage('sortIds was empty on searchResult'));
          break;
        }
      } catch (exc: unknown) {
        logger.error(buildRuleMessage(`[-] search_after and bulk threw an error ${exc}`));
        toReturn.success = false;
        toReturn.errors = [...new Set([...toReturn.errors, `${exc}`])];
        return toReturn;
      }
    }
  }
  logger.debug(buildRuleMessage(`[+] completed bulk index of ${toReturn.createdSignalsCount}`));
  return toReturn;
};
