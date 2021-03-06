/*
 * Copyright 2021 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getVoidLogger } from '@backstage/backend-common';
import { Knex } from 'knex';
import { DatabaseManager } from './database/DatabaseManager';
import {
  DbRefreshStateReferencesRow,
  DbRefreshStateRow,
  DbRelationsRow,
} from './database/DefaultProcessingDatabase';
import { DbSearchRow } from './search';
import { DbFinalEntitiesRow, Stitcher } from './Stitcher';

describe('Stitcher', () => {
  let db: Knex;
  const logger = getVoidLogger();

  beforeEach(async () => {
    db = await DatabaseManager.createTestDatabaseConnection();
    await DatabaseManager.createDatabase(db);
  });

  it('runs the happy path', async () => {
    const stitcher = new Stitcher(db, logger);

    await db.transaction(async tx => {
      await tx<DbRefreshStateRow>('refresh_state').insert([
        {
          entity_id: 'my-id',
          entity_ref: 'k:ns/n',
          unprocessed_entity: JSON.stringify({}),
          processed_entity: JSON.stringify({
            apiVersion: 'a',
            kind: 'k',
            metadata: {
              name: 'n',
              namespace: 'ns',
            },
            spec: {
              k: 'v',
            },
          }),
          errors: '[]',
          next_update_at: tx.fn.now(),
          last_discovery_at: tx.fn.now(),
        },
      ]);
      await tx<DbRefreshStateReferencesRow>('refresh_state_references').insert([
        { source_key: 'a', target_entity_ref: 'k:ns/n' },
      ]);
      await tx<DbRelationsRow>('relations').insert([
        {
          originating_entity_id: 'my-id',
          source_entity_ref: 'k:ns/n',
          type: 'looksAt',
          target_entity_ref: 'k:ns/other',
        },
      ]);
    });

    await stitcher.stitch(new Set(['k:ns/n']));

    let firstEtag: string;
    await db.transaction(async tx => {
      const entities = await tx<DbFinalEntitiesRow>('final_entities');

      expect(entities.length).toBe(1);
      const entity = JSON.parse(entities[0].finalized_entity);
      expect(entity).toEqual({
        relations: [
          {
            type: 'looksAt',
            target: {
              kind: 'k',
              namespace: 'ns',
              name: 'other',
            },
          },
        ],
        apiVersion: 'a',
        kind: 'k',
        metadata: {
          name: 'n',
          namespace: 'ns',
          etag: expect.any(String),
          generation: 1,
          uid: 'my-id',
        },
        spec: {
          k: 'v',
        },
      });

      firstEtag = entity.metadata.etag;

      const search = await tx<DbSearchRow>('search');
      expect(search).toEqual(
        expect.arrayContaining([
          { entity_id: 'my-id', key: 'relations', value: 'looksat:k:ns/other' },
          { entity_id: 'my-id', key: 'apiversion', value: 'a' },
          { entity_id: 'my-id', key: 'kind', value: 'k' },
          { entity_id: 'my-id', key: 'metadata.name', value: 'n' },
          { entity_id: 'my-id', key: 'metadata.namespace', value: 'ns' },
          { entity_id: 'my-id', key: 'metadata.uid', value: 'my-id' },
          { entity_id: 'my-id', key: 'spec.k', value: 'v' },
        ]),
      );
    });

    // Re-stitch without any changes
    await stitcher.stitch(new Set(['k:ns/n']));

    await db.transaction(async tx => {
      const entities = await tx<DbFinalEntitiesRow>('final_entities');
      expect(entities.length).toBe(1);
      const entity = JSON.parse(entities[0].finalized_entity);
      expect(entities[0].etag).toEqual(firstEtag);
      expect(entity.metadata.etag).toEqual(firstEtag);
    });

    // Now add one more relation and re-stitch
    await db.transaction(async tx => {
      await tx<DbRelationsRow>('relations').insert([
        {
          originating_entity_id: 'my-id',
          source_entity_ref: 'k:ns/n',
          type: 'looksAt',
          target_entity_ref: 'k:ns/third',
        },
      ]);
    });

    await stitcher.stitch(new Set(['k:ns/n']));

    await db.transaction(async tx => {
      const entities = await tx<DbFinalEntitiesRow>('final_entities');

      expect(entities.length).toBe(1);
      const entity = JSON.parse(entities[0].finalized_entity);
      expect(entity).toEqual({
        relations: expect.arrayContaining([
          {
            type: 'looksAt',
            target: {
              kind: 'k',
              namespace: 'ns',
              name: 'other',
            },
          },
          {
            type: 'looksAt',
            target: {
              kind: 'k',
              namespace: 'ns',
              name: 'third',
            },
          },
        ]),
        apiVersion: 'a',
        kind: 'k',
        metadata: {
          name: 'n',
          namespace: 'ns',
          etag: expect.any(String),
          generation: 1,
          uid: 'my-id',
        },
        spec: {
          k: 'v',
        },
      });

      expect(entities[0].etag).not.toEqual(firstEtag);
      expect(entities[0].etag).toEqual(entity.metadata.etag);

      const search = await tx<DbSearchRow>('search');
      expect(search).toEqual(
        expect.arrayContaining([
          { entity_id: 'my-id', key: 'relations', value: 'looksat:k:ns/other' },
          { entity_id: 'my-id', key: 'relations', value: 'looksat:k:ns/third' },
          { entity_id: 'my-id', key: 'apiversion', value: 'a' },
          { entity_id: 'my-id', key: 'kind', value: 'k' },
          { entity_id: 'my-id', key: 'metadata.name', value: 'n' },
          { entity_id: 'my-id', key: 'metadata.namespace', value: 'ns' },
          { entity_id: 'my-id', key: 'metadata.uid', value: 'my-id' },
          { entity_id: 'my-id', key: 'spec.k', value: 'v' },
        ]),
      );
    });
  });
});
