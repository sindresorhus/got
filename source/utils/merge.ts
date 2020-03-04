import {URL} from 'url';
import is from '@sindresorhus/is';
import {Merge} from 'type-fest';
import caseless = require('caseless');

const headerFuncRe = /^(?:[gs]et|has|remove)Header$/;
const isHttpified = (obj: {[key: string]: any}): obj is caseless.Httpified =>
	Reflect.has(obj, 'headers') && is.function_(obj.setHeader);

export default function merge<Target extends {[key: string]: any}, Source extends {[key: string]: any}>(target: Target, ...sources: Source[]): Merge<Source, Target> {
	let targetHasHeaders = isHttpified(target);
	for (const source of sources) {
		const sourceHasHeaders = isHttpified(source);
		for (const [key, sourceValue] of Object.entries(source)) {
			if (sourceHasHeaders && headerFuncRe.test(key)) {
				continue;
			}

			const targetValue = target[key];

			if (key === 'headers' && (targetHasHeaders || sourceHasHeaders)) {
				if (targetHasHeaders) {
					for (const [name, value] of Object.entries(sourceValue)) {
						if (is.undefined(value)) {
							(target as unknown as caseless.Httpified).removeHeader(name);
						} else {
							(target as unknown as caseless.Httpified).setHeader(name, value);
						}
					}
				} else {
					caseless.httpify(target, sourceValue);
					targetHasHeaders = true;
				}
			} else if (is.urlInstance(targetValue) && is.string(sourceValue)) {
				// @ts-ignore TS doesn't recognise Target accepts string keys
				target[key] = new URL(sourceValue, targetValue);
			} else if (is.plainObject(sourceValue)) {
				if (is.plainObject(targetValue)) {
					// @ts-ignore TS doesn't recognise Target accepts string keys
					target[key] = merge({}, targetValue, sourceValue);
				} else {
					// @ts-ignore TS doesn't recognise Target accepts string keys
					target[key] = merge({}, sourceValue);
				}
			} else if (is.array(sourceValue)) {
				// @ts-ignore TS doesn't recognise Target accepts string keys
				target[key] = sourceValue.slice();
			} else {
				// @ts-ignore TS doesn't recognise Target accepts string keys
				target[key] = sourceValue;
			}
		}
	}

	return target as Merge<Source, Target>;
}
