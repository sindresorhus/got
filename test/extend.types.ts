/* eslint-disable @typescript-eslint/no-unnecessary-type-arguments -- Explicitly testing type arguments that TypeScript could infer, to verify the types are correct */
import type {LookupFunction} from 'node:net';
import {expectTypeOf} from 'expect-type';
import got, {
	Options,
	type NativeRequestOptions as PublicNativeRequestOptions,
	type OptionsInit,
	type Request,
	type RequestPromise,
	type Response,
} from '../source/index.js';
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
// Compare the inferred options directly because Got instances have recursive types.
//
const wrappedInstance = got.extend({resolveBodyOnly: false});
const bodyOnlyInstance = got.extend({resolveBodyOnly: true});
const mergedBodyOnlyInstance = got.extend(bodyOnlyInstance);
const mergedWrappedInstance = got.extend(wrappedInstance);
const wrappedOptionsOverride = got.extend(bodyOnlyInstance, {resolveBodyOnly: false});
const bodyOnlyOptionsOverride = got.extend(wrappedInstance, {resolveBodyOnly: true});
const wrappedInstanceOverride = got.extend({resolveBodyOnly: true}, wrappedInstance);
const bodyOnlyInstanceOverride = got.extend({resolveBodyOnly: false}, bodyOnlyInstance);

expectTypeOf<ExtractExtendOptions<typeof wrappedInstance>>().toEqualTypeOf<{resolveBodyOnly: false}>();
expectTypeOf<ExtractExtendOptions<typeof bodyOnlyInstance>>().toEqualTypeOf<{resolveBodyOnly: true}>();
expectTypeOf<ExtractExtendOptions<typeof mergedBodyOnlyInstance>>().toEqualTypeOf<{resolveBodyOnly: true}>();
expectTypeOf<ExtractExtendOptions<typeof mergedWrappedInstance>>().toEqualTypeOf<{resolveBodyOnly: false}>();
expectTypeOf<ExtractExtendOptions<typeof wrappedOptionsOverride>>().toEqualTypeOf<{resolveBodyOnly: false}>();
expectTypeOf<ExtractExtendOptions<typeof bodyOnlyOptionsOverride>>().toEqualTypeOf<{resolveBodyOnly: true}>();
expectTypeOf<ExtractExtendOptions<typeof wrappedInstanceOverride>>().toEqualTypeOf<{resolveBodyOnly: false}>();
expectTypeOf<ExtractExtendOptions<typeof bodyOnlyInstanceOverride>>().toEqualTypeOf<{resolveBodyOnly: true}>();

//
// Test that created instances enable the correct return types for the request functions
//
const gotWrapped = got.extend({});
const queryMethodOptions: OptionsInit = {method: 'query'};
expectTypeOf(queryMethodOptions).toEqualTypeOf<OptionsInit>();

// The following tests would apply to all of the method signatures (get, post, put, delete, etc...), but we only test the base function for brevity

// Test the default instance
expectTypeOf(gotWrapped('https://example.com')).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(gotWrapped<{test: 'test'}>('https://example.com')).toEqualTypeOf<RequestPromise<Response<{test: 'test'}>>>();
expectTypeOf(gotWrapped('https://example.com', {responseType: 'buffer'})).toEqualTypeOf<RequestPromise<Response<Uint8Array<ArrayBuffer>>>>();
expectTypeOf(gotWrapped.query<{test: 'test'}>('https://example.com')).toEqualTypeOf<RequestPromise<Response<{test: 'test'}>>>();
expectTypeOf(got.stream.query('https://example.com')).toEqualTypeOf<Request>();
expectTypeOf(gotWrapped.stream.query('https://example.com')).toEqualTypeOf<Request>();

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
expectTypeOf(invalidStrictOptions).toEqualTypeOf<StrictOptions>();

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
expectTypeOf(invalidExtendOptions).toEqualTypeOf<ExtendOptions>();

// Test shortcut methods preserve RequestPromise return shape
expectTypeOf(got('https://example.com').json<{data: string}>()).toEqualTypeOf<RequestPromise<{data: string}>>();
expectTypeOf(got('https://example.com').buffer()).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(got('https://example.com').text()).toEqualTypeOf<RequestPromise<string>>();

const lookup: LookupFunction = () => {};
const clear = () => {};
expectTypeOf(got('https://example.com', {
	dnsCache: {
		lookup,
		clear,
	},
})).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(got.extend({
	dnsCache: {
		lookup,
	},
})).toExtend<Got>();
expectTypeOf(got.extend({
	dnsCache: true,
})).toExtend<Got>();
expectTypeOf(got.extend({
	dnsCache: false,
})).toExtend<Got>();
const optionsInit: OptionsInit = {
	dnsCache: true,
};
expectTypeOf(optionsInit).toEqualTypeOf<OptionsInit>();

const options = new Options({
	dnsCache: {
		lookup,
	},
});
type NativeRequestOptions = ReturnType<Options['createNativeRequestOptions']>;

expectTypeOf(options.dnsCache).toExtend<{lookup: LookupFunction} | undefined>();
expectTypeOf<NativeRequestOptions['lookup']>().toEqualTypeOf<LookupFunction | undefined>();
expectTypeOf<NativeRequestOptions>().not.toHaveProperty('_socketTimeout');
expectTypeOf<PublicNativeRequestOptions>().not.toHaveProperty('_socketTimeout');

// Re-extending preserves the parent's response defaults, including with no new options.
const chainedBufferClient = got.extend({responseType: 'buffer', resolveBodyOnly: true}).extend({headers: {'x-test': 'yes'}});
expectTypeOf(chainedBufferClient('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(got.extend()('https://example.com')).toEqualTypeOf<RequestPromise<Response<string>>>();

expectTypeOf(chainedBufferClient.extend()('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(chainedBufferClient.get('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(chainedBufferClient({})).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(chainedBufferClient.extend({resolveBodyOnly: false}).get('https://example.com')).toEqualTypeOf<RequestPromise<Response<Uint8Array<ArrayBuffer>>>>();
expectTypeOf(chainedBufferClient.extend({responseType: 'text'}).post('https://example.com')).toEqualTypeOf<RequestPromise<string>>();
expectTypeOf(chainedBufferClient.extend({headers: {'x-extra': 'yes'}}).extend()('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotJson.extend()('https://example.com')).toEqualTypeOf<RequestPromise<Response<unknown>>>();
expectTypeOf(gotJson.extend({headers: {'x-test': 'yes'}})('https://example.com')).toEqualTypeOf<RequestPromise<Response<unknown>>>();
expectTypeOf(gotJsonBodyOnly.extend({})<{data: string}>('https://example.com')).toEqualTypeOf<RequestPromise<{data: string}>>();
expectTypeOf(gotJsonBodyOnly.extend(gotText)('https://example.com')).toEqualTypeOf<RequestPromise<string>>();
expectTypeOf(gotBodyOnly.extend(gotBuffer).head('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotBuffer.extend(gotJson, {resolveBodyOnly: true})('https://example.com')).toEqualTypeOf<RequestPromise<unknown>>();

// Arrays of configuration layers must not collapse the merged options to never.
const headerConfigurations: Array<{headers: Record<string, string>}> = [{headers: {'x-test': 'yes'}}];
expectTypeOf(got.extend(...headerConfigurations)('https://example.com')).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(gotBufferBodyOnly.extend(...headerConfigurations)('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
const emptyConfigurations: never[] = [];
expectTypeOf(got.extend(...emptyConfigurations)('https://example.com')).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(gotBufferBodyOnly.extend(...emptyConfigurations).get('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(got.extend(...headerConfigurations, {responseType: 'buffer', resolveBodyOnly: true})('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf<MergeExtendsConfig<never[]>>().toEqualTypeOf<Record<never, never>>();
expectTypeOf<MergeExtendsConfig<Array<{resolveBodyOnly: true}>>>().toEqualTypeOf<{resolveBodyOnly?: true}>();
expectTypeOf<MergeExtendsConfig<[{resolveBodyOnly: false}, ...Array<{resolveBodyOnly: true}>]>>().toEqualTypeOf<{resolveBodyOnly: boolean}>();
expectTypeOf<MergeExtendsConfig<[{responseType: 'buffer'}, ...Array<{responseType?: 'text'}>]>>().toEqualTypeOf<{responseType: 'buffer' | 'text'}>();
expectTypeOf<MergeExtendsConfig<[{responseType: 'buffer'}, ...Array<{responseType: 'text' | 'json'}>]>>().toEqualTypeOf<{responseType: 'buffer' | 'text' | 'json'}>();
expectTypeOf<MergeExtendsConfig<[Got<{resolveBodyOnly: true}>, ...Array<Got<{responseType: 'buffer'}>>]>>().toEqualTypeOf<{resolveBodyOnly: true; responseType?: 'buffer'}>();

// Explicitly undefined scalar options preserve inherited defaults at runtime.
expectTypeOf(gotBufferBodyOnly.extend({responseType: undefined})('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotBufferBodyOnly.extend({resolveBodyOnly: undefined})('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(got.extend({responseType: undefined, resolveBodyOnly: undefined})('https://example.com')).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(gotBufferBodyOnly.extend({responseType: undefined, resolveBodyOnly: undefined}).get('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotBufferBodyOnly.extend(got.extend({responseType: undefined, resolveBodyOnly: undefined}))('https://example.com')).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotBufferBodyOnly.extend({responseType: undefined}, {responseType: 'text', resolveBodyOnly: false})('https://example.com')).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf<MergeExtendsConfig<[{resolveBodyOnly: true}, {resolveBodyOnly?: undefined}]>>().toEqualTypeOf<{resolveBodyOnly: true}>();
expectTypeOf<MergeExtendsConfig<[{responseType: 'buffer'}, ...Array<{responseType: undefined}>]>>().toEqualTypeOf<{responseType: 'buffer'}>();
expectTypeOf<MergeExtendsConfig<[{searchParams: {page: number}}, {searchParams: undefined}]>>().toEqualTypeOf<{searchParams: undefined}>();
expectTypeOf<MergeExtendsConfig<[{headers: {'x-test': undefined}}]>>().toEqualTypeOf<{headers: {'x-test': undefined}}>();

// Optional array layers can change the response body and whether it is wrapped.
const bufferConfigurations: Array<{responseType: 'buffer'}> = [{responseType: 'buffer'}];
const possibleBufferRequest = got.extend(...bufferConfigurations)('https://example.com');
expectTypeOf<Awaited<typeof possibleBufferRequest>>().toEqualTypeOf<Response<string | Uint8Array<ArrayBuffer>>>();
const bodyOnlyConfigurations: Array<{resolveBodyOnly: boolean}> = [{resolveBodyOnly: true}];
const possibleBodyOnlyRequest = got.extend(...bodyOnlyConfigurations)('https://example.com');
expectTypeOf<Awaited<typeof possibleBodyOnlyRequest>>().toEqualTypeOf<string | Response<string>>();
const broadConfigurations: ExtendOptions = {};
const broadRequest = got.extend(broadConfigurations)('https://example.com');
expectTypeOf<Awaited<typeof broadRequest>>().toEqualTypeOf<unknown>();
const chainedBroadRequest = got.extend(broadConfigurations).extend({headers: {'x-test': 'yes'}})('https://example.com');
expectTypeOf<Awaited<typeof chainedBroadRequest>>().toEqualTypeOf<unknown>();
const dynamicBodyOnlyRequest = got.extend({resolveBodyOnly: Math.random() > 0.5})('https://example.com');
expectTypeOf<Awaited<typeof dynamicBodyOnlyRequest>>().toEqualTypeOf<string | Response<string>>();
const dynamicResponseRequest = got.extend({responseType: Math.random() > 0.5 ? 'text' : 'buffer'})('https://example.com');
expectTypeOf<Awaited<typeof dynamicResponseRequest>>().toEqualTypeOf<Response<string | Uint8Array<ArrayBuffer>>>();
const emptyBufferConfigurations: Array<{responseType: 'buffer'}> = [];
const emptyBufferRequest = got.extend(...emptyBufferConfigurations)('https://example.com');
expectTypeOf<Awaited<typeof emptyBufferRequest>>().toEqualTypeOf<Response<string | Uint8Array<ArrayBuffer>>>();
const optionalTextConfigurations: Array<{responseType?: 'text'}> = [];
const parentBufferRequest = gotBufferBodyOnly.extend(...optionalTextConfigurations)('https://example.com');
expectTypeOf<Awaited<typeof parentBufferRequest>>().toEqualTypeOf<string | Uint8Array<ArrayBuffer>>();
const optionalBodyConfigurations: Array<{resolveBodyOnly?: true}> = [];
const optionalBodyRequest = got.extend(...optionalBodyConfigurations).get('https://example.com');
expectTypeOf<Awaited<typeof optionalBodyRequest>>().toEqualTypeOf<string | Response<string>>();
expectTypeOf(got.extend(...bodyOnlyConfigurations)('https://example.com', {resolveBodyOnly: false})).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(got.extend(...bodyOnlyConfigurations)('https://example.com', {resolveBodyOnly: true})).toEqualTypeOf<RequestPromise<string>>();
expectTypeOf(dynamicResponseRequest.text()).toEqualTypeOf<RequestPromise<string>>();

const mutableClient = got.extend({mutableDefaults: true});
// @ts-expect-error The mutability flag cannot be changed after creating an instance.
mutableClient.defaults.mutableDefaults = false;
// @ts-expect-error The defaults binding is read-only even when its contents are mutable.
mutableClient.defaults = got.defaults;
const immutableClient = got.extend();
// @ts-expect-error Immutable instances also expose a read-only mutability flag.
immutableClient.defaults.mutableDefaults = true;
// @ts-expect-error Immutable instances also expose a read-only defaults binding.
immutableClient.defaults = mutableClient.defaults;
mutableClient.defaults.options = new Options();
mutableClient.defaults.options.responseType = 'json';
mutableClient.defaults.handlers = [];

expectTypeOf(gotBufferBodyOnly('https://example.com', {responseType: undefined})).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotBufferBodyOnly('https://example.com', {resolveBodyOnly: undefined})).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotBufferBodyOnly('https://example.com', {responseType: undefined, resolveBodyOnly: false})).toEqualTypeOf<RequestPromise<Response<Uint8Array<ArrayBuffer>>>>();
expectTypeOf(gotBufferBodyOnly({responseType: undefined, resolveBodyOnly: undefined})).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotBufferBodyOnly.get('https://example.com', {responseType: undefined})).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotBufferBodyOnly.post({resolveBodyOnly: undefined})).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();
expectTypeOf(gotBuffer({responseType: undefined, resolveBodyOnly: undefined})).toEqualTypeOf<RequestPromise<Response<Uint8Array<ArrayBuffer>>>>();
expectTypeOf(gotJsonBodyOnly('https://example.com', {responseType: undefined})).toEqualTypeOf<RequestPromise<unknown>>();
expectTypeOf(gotJson<{value: number}>({responseType: 'json', resolveBodyOnly: undefined})).toEqualTypeOf<RequestPromise<Response<{value: number}>>>();
expectTypeOf(got('https://example.com', {responseType: undefined, resolveBodyOnly: undefined})).toEqualTypeOf<RequestPromise<Response<string>>>();
expectTypeOf(gotBufferBodyOnly({responseType: 'text', resolveBodyOnly: undefined})).toEqualTypeOf<RequestPromise<string>>();
const inheritedResponseOptions: {responseType?: undefined; resolveBodyOnly?: undefined} = {};
expectTypeOf(gotBufferBodyOnly('https://example.com', inheritedResponseOptions)).toEqualTypeOf<RequestPromise<Uint8Array<ArrayBuffer>>>();

got.extend({
	hooks: {
		beforeRequest: [options => {
			options.url = 'https://example.com/next';
			options.prefixUrl = new URL('https://example.com/');
			options.dnsCache = true;
			expectTypeOf(options.url).toEqualTypeOf<URL | undefined>();
			expectTypeOf(options.prefixUrl).toEqualTypeOf<string>();
			expectTypeOf(options.dnsCache).toEqualTypeOf<Options['dnsCache']>();
			options.url = new URL('https://example.com/next');
			options.prefixUrl = 'https://example.com/';
			const {dnsCache} = options;
			options.dnsCache = dnsCache;
			options.dnsCache = false;
			options.dnsCache = undefined;
			// @ts-expect-error URL setters still reject numbers.
			options.url = 123;
			// @ts-expect-error Prefix URL setters still reject booleans.
			options.prefixUrl = false;
			// @ts-expect-error DNS caches must be instances or booleans.
			options.dnsCache = 'cache';
		}],
		beforeRedirect: [options => {
			options.url = 'https://example.com/redirected';
			options.prefixUrl = new URL('https://example.com/');
			expectTypeOf(options.url).toEqualTypeOf<URL | undefined>();
			expectTypeOf(options.prefixUrl).toEqualTypeOf<string>();
		}],
	},
});
