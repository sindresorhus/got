import type {Buffer} from 'node:buffer';
import {expectTypeOf} from 'expect-type';
import got, {type CancelableRequest, type Response} from '../source/index.js';
import {type Got, type MergeExtendsConfig, type ExtractExtendOptions} from '../source/types.js';

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
expectTypeOf(gotWrapped('https://example.com')).toEqualTypeOf<CancelableRequest<Response<string>>>();
expectTypeOf(gotWrapped<{test: 'test'}>('https://example.com')).toEqualTypeOf<CancelableRequest<Response<{test: 'test'}>>>();
expectTypeOf(gotWrapped('https://example.com', {responseType: 'buffer'})).toEqualTypeOf<CancelableRequest<Response<Buffer>>>();

// Test the default instance can be overridden at the request function level
expectTypeOf(gotWrapped('https://example.com', {resolveBodyOnly: true})).toEqualTypeOf<CancelableRequest<string>>();
expectTypeOf(gotWrapped<{test: 'test'}>('https://example.com', {resolveBodyOnly: true})).toEqualTypeOf<CancelableRequest<{test: 'test'}>>();
expectTypeOf(gotWrapped('https://example.com', {responseType: 'buffer', resolveBodyOnly: true})).toEqualTypeOf<CancelableRequest<Buffer>>();

const gotBodyOnly = got.extend({resolveBodyOnly: true});

// Test the instance with resolveBodyOnly as an extend option
expectTypeOf(gotBodyOnly('https://example.com')).toEqualTypeOf<CancelableRequest<string>>();
expectTypeOf(gotBodyOnly<{test: 'test'}>('https://example.com')).toEqualTypeOf<CancelableRequest<{test: 'test'}>>();
expectTypeOf(gotBodyOnly('https://example.com', {responseType: 'buffer'})).toEqualTypeOf<CancelableRequest<Buffer>>();

// Test the instance with resolveBodyOnly as an extend option can be overridden at the request function level
expectTypeOf(gotBodyOnly('https://example.com', {resolveBodyOnly: false})).toEqualTypeOf<CancelableRequest<Response<string>>>();
expectTypeOf(gotBodyOnly<{test: 'test'}>('https://example.com', {resolveBodyOnly: false})).toEqualTypeOf<CancelableRequest<Response<{test: 'test'}>>>();
expectTypeOf(gotBodyOnly('https://example.com', {responseType: 'buffer', resolveBodyOnly: false})).toEqualTypeOf<CancelableRequest<Response<Buffer>>>();
