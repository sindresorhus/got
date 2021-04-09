import create from './create';
import {InstanceDefaults} from './types';
import Options from './core/options';

const defaults: InstanceDefaults = {
	options: new Options(),
	handlers: [],
	mutableDefaults: false
};

const got = create(defaults);

export default got;
export {got};

export {default as Options} from './core/options';
export * from './core/options';
export * from './core/response';
export * from './core/index';
export * from './core/errors';
export {default as calculateRetryDelay} from './core/calculate-retry-delay';
export * from './as-promise/types';
export * from './types';
export {default as create} from './create';
export {default as parseLinkHeader} from './core/parse-link-header';
