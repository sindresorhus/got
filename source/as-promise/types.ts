import {type RequestEvents} from '../core/index.js';
import type {Response} from '../core/response.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Internal recursive shape requires interface; public API remains a type alias.
interface RequestPromiseShape<T extends Response | Response['body'] = Response['body']> extends RequestEvents<RequestPromise<T>> {
	/**
	A shortcut method that gives a Promise returning a JSON object.

	It is semantically the same as setting `options.resolveBodyOnly` to `true` and `options.responseType` to `'json'`.
	*/
	json: <ReturnType>() => RequestPromise<ReturnType>;

	/**
	A shortcut method that gives a Promise returning a [Uint8Array](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array).

	It is semantically the same as setting `options.resolveBodyOnly` to `true` and `options.responseType` to `'buffer'`.
	*/
	buffer: () => RequestPromise<Uint8Array<ArrayBuffer>>;

	/**
	A shortcut method that gives a Promise returning a string.

	It is semantically the same as setting `options.resolveBodyOnly` to `true` and `options.responseType` to `'text'`.
	*/
	text: () => RequestPromise<string>;
}

// This is intentionally a type alias to keep structural typing predictable.
// Augmenting it via interface merging is not supported.
export type RequestPromise<T extends Response | Response['body'] = Response['body']> = Promise<T> & RequestPromiseShape<T>;
