/* eslint-disable @typescript-eslint/no-unnecessary-type-arguments */
import {expectTypeOf} from 'expect-type';
import got, {type RequestPromise, type Response} from '../source/index.js';
import {
	type Got,
	type MergeExtendsConfig,
	type ExtractExtendOptions,
	type StrictOptions,
	type ExtendOptions,
} from '../source/types.js';

// Ensure we properly extract the `extend` options from a Got instance which is used in MergeExtendsConfig generic
expectTypeOf<ExtractExtendOptions<Got<{resolveBodyOnly: false}>>>().toEqualTypeOf<{resolveBodyOnly: false}>();
expectTypeOf<ExtractExtendOptions<Got<{resolveBodyOnly: true}>>>().toEqualTypeOf<{resolveBodyOnly: true}>();
expectTypeOf<ExtractExtendOptions<{resolveBodyOnly: false}>>().toEqualTypeOf<{resolveBodyOnly: false}>();
expectTypeOf<ExtractExtendOptions<{resolveBodyOnly: true}>>().toEqualTypeOf<{resolveBodyOnly: true}>();

//
// Tests for MergeExtendsConfig - which merges the potential arguments of the `got.extend` method
//
// MergeExtendsConfig works with a single value
expectTypeOf<MergeExtendsConfig<[{resolveBodyOnly: false}]>>().toEqualTypeOf<{resolveBodyOnly: false}>();
expectTypeOf<MergeExtendsConfig<[{resolveBodyOnly: true}]>>().toEqualTypeOf<{resolveBodyOnly: true}>();
expectTypeOf<MergeExtendsConfig<[Got<{resolveBodyOnly: false}>]>>().toEqualTypeOf<{resolveBodyOnly: false}>();
expectTypeOf<MergeExtendsConfig<[Got<{resolveBodyOnly: true}>]>>().toEqualTypeOf<{resolveBodyOnly: true}>();

// MergeExtendsConfig merges multiple ExtendOptions
expectTypeOf<MergeExtendsConfig<[{resolveBodyOnly: false}, {resolveBodyOnly: true}]>>().toEqualTypeOf<{resolveBodyOnly: true}>();
expectTypeOf<MergeExtendsConfig<[{resolveBodyOnly: true}, {resolveBodyOnly: false}]>>().toEqualTypeOf<{resolveBodyOnly: false}>();

// MergeExtendsConfig merges multiple Got instances
expectTypeOf<MergeExtendsConfig<[Got<{resolveBodyOnly: false}>, Got<{resolveBodyOnly: true}>]>>().toEqualTypeOf<{resolveBodyOnly: true}>();
expectTypeOf<MergeExtendsConfig<[Got<{resolveBodyOnly: true}>, Got<{resolveBodyOnly: false}>]>>().toEqualTypeOf<{resolveBodyOnly: false}>();

// MergeExtendsConfig merges multiple Got instances and ExtendOptions with Got first argument
expectTypeOf<MergeExtendsConfig<[Got<{resolveBodyOnly: false}>, {resolveBodyOnly: true}]>>().toEqualTypeOf<{resolveBodyOnly: true}>();
expectTypeOf<MergeExtendsConfig<[Got<{resolveBodyOnly: true}>, {resolveBodyOnly: false}]>>().toEqualTypeOf<{resolveBodyOnly: false}>();

// MergeExtendsConfig merges multiple Got instances and ExtendOptions with ExtendOptions first argument
expectTypeOf<MergeExtendsConfig<[{resolveBodyOnly: true}, Got<{resolveBodyOnly: false}>]>>().toEqualTypeOf<{resolveBodyOnly: false}>();
expectTypeOf<MergeExtendsConfig<[{resolveBodyOnly: false}, Got<{resolveBodyOnly: true}>]>>().toEqualTypeOf<{resolveBodyOnly: true}>();

//
// Test the implementation of got.extend types
//
expectTypeOf(got.extend({resolveBodyOnly: false})).toEqualTypeOf<Got<{resolveBodyOnly: false}>>();
expectTypeOf(got.extend({resolveBodyOnly: true})).toEqualTypeOf<Got<{resolveBodyOnly: true}>>();
expectTypeOf(got.extend(got.extend({resolveBodyOnly: true}))).toEqualTypeOf<Got<{resolveBodyOnly: true}>>();
expectTypeOf(got.extend(got.extend({resolveBodyOnly: false}))).toEqualTypeOf<Got<{resolveBodyOnly: false}>>();
expectTypeOf(got.extend(got.extend({resolveBodyOnly: true}), {resolveBodyOnly: false})).toEqualTypeOf<Got<{resolveBodyOnly: false}>>();
expectTypeOf(got.extend(got.extend({resolveBodyOnly: false}), {resolveBodyOnly: true})).toEqualTypeOf<Got<{resolveBodyOnly: true}>>();
expectTypeOf(got.extend({resolveBodyOnly: true}, got.extend({resolveBodyOnly: false}))).toEqualTypeOf<Got<{resolveBodyOnly: false}>>();
expectTypeOf(got.extend({resolveBodyOnly: false}, got.extend({resolveBodyOnly: true}))).toEqualTypeOf<Got<{resolveBodyOnly: true}>>();

//
// Test that created instances enable the correct return types for the request functions
//
const gotWrapped = got.extend({});

// The following tests would apply to all of the method signatures (get, post, put, delete, etc...), but we only test the base function for brevity

// Test the default instance
expectTypeOf(gotWrapped('https://example.com')).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(gotWrapped<{test: 'test'}>('https://example.com')).toEqualTypeOf<RequestPromise<Response<{test: 'test'}>>>();
expectTypeOf(gotWrapped('https://example.com', {responseType: 'buffer'})).toEqualTypeOf<RequestPromise<Response<Uint8Array<ArrayBuffer>>>>();

// Test the default instance can be overridden at the request function level
expectTypeOf(gotWrapped('https://example.com', {resolveBodyOnly: true})).toEqualTypeOf<RequestPromise<string>>();
expectTypeOf(gotWrapped<{test: 'test'}>('https://example.com', {resolveBodyOnly: true})).toEqualTypeOf<RequestPromise<{test: 'test'}>>();
expectTypeOf(gotWrapped('https://example.com', {responseType: 'buffer', resolveBodyOnly: true})).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();

const gotBodyOnly = got.extend({resolveBodyOnly: true});

// Test the instance with resolveBodyOnly as an extend option
expectTypeOf(gotBodyOnly('https://example.com')).toEqualTypeOf<RequestPromise<string>>();
expectTypeOf(gotBodyOnly<{test: 'test'}>('https://example.com')).toEqualTypeOf<RequestPromise<{test: 'test'}>>();
expectTypeOf(gotBodyOnly('https://example.com', {responseType: 'buffer'})).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();

// Test the instance with resolveBodyOnly as an extend option can be overridden at the request function level
expectTypeOf(gotBodyOnly('https://example.com', {resolveBodyOnly: false})).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(gotBodyOnly<{test: 'test'}>('https://example.com', {resolveBodyOnly: false})).toEqualTypeOf<RequestPromise<Response<{test: 'test'}>>>();
expectTypeOf(gotBodyOnly('https://example.com', {responseType: 'buffer', resolveBodyOnly: false})).toEqualTypeOf<RequestPromise<Response<Uint8Array<ArrayBuffer>>>>();

//
// Test got.extend() with responseType correctly infers types (fix for issue #2427)
//
const gotJson = got.extend({responseType: 'json'});
const gotJsonBodyOnly = got.extend({responseType: 'json', resolveBodyOnly: true});
const gotBuffer = got.extend({responseType: 'buffer'});
const gotBufferBodyOnly = got.extend({responseType: 'buffer', resolveBodyOnly: true});
const gotText = got.extend({responseType: 'text'});
const gotTextBodyOnly = got.extend({responseType: 'text', resolveBodyOnly: true});

// Test URL-first syntax without options - should infer correct type based on extended responseType
expectTypeOf(gotJson('https://example.com')).toEqualTypeOf<RequestPromise<Response<unknown>>>();
expectTypeOf(gotJsonBodyOnly('https://example.com')).toEqualTypeOf<RequestPromise<unknown>>();
expectTypeOf(gotBuffer('https://example.com')).toEqualTypeOf<RequestPromise<Response<Uint8Array<ArrayBuffer>>>>();
expectTypeOf(gotBufferBodyOnly('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotText('https://example.com')).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(gotTextBodyOnly('https://example.com')).toEqualTypeOf<RequestPromise<string>>();

// @ts-expect-error `url` must be passed as the first argument.
const invalidStrictOptions: StrictOptions = {url: 'https://example.com'};
void invalidStrictOptions;

// Test that generic type parameter still works with extended responseType
expectTypeOf(gotJson<{data: string}>('https://example.com')).toEqualTypeOf<RequestPromise<Response<{data: string}>>>();
expectTypeOf(gotJsonBodyOnly<{data: string}>('https://example.com')).toEqualTypeOf<RequestPromise<{data: string}>>();

// Test that explicit responseType in call overrides extended responseType
expectTypeOf(gotJson('https://example.com', {responseType: 'buffer'})).toEqualTypeOf<RequestPromise<Response<Uint8Array<ArrayBuffer>>>>();
expectTypeOf(gotJson('https://example.com', {responseType: 'text'})).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(gotBuffer('https://example.com', {responseType: 'json'})).toEqualTypeOf<RequestPromise<Response<unknown>>>();
expectTypeOf(gotBuffer('https://example.com', {responseType: 'text'})).toEqualTypeOf<RequestPromise<Response<string>>>();

// Test that resolveBodyOnly can be overridden with explicit responseType
expectTypeOf(gotJson('https://example.com', {responseType: 'json', resolveBodyOnly: true})).toEqualTypeOf<RequestPromise<unknown>>();
expectTypeOf(gotJsonBodyOnly('https://example.com', {responseType: 'json', resolveBodyOnly: false})).toEqualTypeOf<RequestPromise<Response<unknown>>>();
expectTypeOf(gotBuffer('https://example.com', {responseType: 'buffer', resolveBodyOnly: true})).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotBufferBodyOnly('https://example.com', {responseType: 'buffer', resolveBodyOnly: false})).toEqualTypeOf<RequestPromise<Response<Uint8Array<ArrayBuffer>>>>();

// @ts-expect-error `url` must not be accepted by extend options.
const invalidExtendOptions: ExtendOptions = {url: 'https://example.com'};
void invalidExtendOptions;

// Test shortcut methods preserve RequestPromise return shape
expectTypeOf(got('https://example.com').json<{data: string}>()).toEqualTypeOf<RequestPromise<{data: string}>>();
expectTypeOf(got('https://example.com').buffer()).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(got('https://example.com').text()).toEqualTypeOf<RequestPromise<string>>();
