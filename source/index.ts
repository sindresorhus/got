import create from './create.js';
import type {InstanceDefaults} from './types.js';
import Options from './core/options.js';

const defaults: InstanceDefaults = {
	options: new Options(),
	handlers: [],
	mutableDefaults: false,
};

const got = create(defaults);

export default got;

export {default as Options} from './core/options.js';
export * from './core/options.js';
export * from './core/response.js';
export type {default as Request} from './core/index.js';
export * from './core/index.js';
export * from './core/errors.js';
export type {StandardSchemaV1, StandardSchemaV1InferOutput, StandardSchemaV1Issue} from './core/standard-schema.js';
export * from './core/diagnostics-channel.js';
export type {Delays} from './core/timed-out.js';
export type {Timings} from './core/utils/timer.js';
export {default as calculateRetryDelay} from './core/calculate-retry-delay.js';
export type {DnsCacheLookup, DnsCacheOptions} from './core/utils/dns-cache.js';
export type * from './as-promise/types.js';
export type * from './types.js';
export {default as create} from './create.js';
export {default as parseLinkHeader} from './core/parse-link-header.js';
