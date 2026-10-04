import {expectTypeOf} from 'expect-type';
import type {DnsCacheLookup} from '../../source/index.js';

// The docs tell users to implement a DNS cache with `lookup` and `clear(hostname?)`, so the
// contract type must be importable from the package root.
expectTypeOf<DnsCacheLookup['lookup']>().toBeFunction();
expectTypeOf<DnsCacheLookup['clear']>().toBeNullable();
