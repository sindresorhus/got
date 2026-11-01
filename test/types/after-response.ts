import {expectTypeOf} from 'expect-type';
import type {AfterResponseHook, OptionsInit} from '../../source/index.js';

type RetryAfterResponse = Parameters<AfterResponseHook>[1];

expectTypeOf<ReturnType<RetryAfterResponse>>().toEqualTypeOf<Promise<never>>();
expectTypeOf<Awaited<ReturnType<RetryAfterResponse>>>().toEqualTypeOf<never>();
expectTypeOf<Parameters<RetryAfterResponse>>().toEqualTypeOf<[OptionsInit]>();
