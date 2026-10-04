import {expectTypeOf} from 'expect-type';
import {type Headers, type OptionsInit} from '../../source/core/options.js';
import type {DiagnosticResponseStart} from '../../source/core/diagnostics-channel.js';

// Node's OutgoingHttpHeaders allows numbers, so the input accepts them.
expectTypeOf<NonNullable<OptionsInit['headers']>['x-number']>().toEqualTypeOf<string | string[] | number | undefined>();

// Numbers are stored as strings, so reading a header keeps the published type.
expectTypeOf<Headers['x-number']>().toEqualTypeOf<string | string[] | undefined>();
expectTypeOf<DiagnosticResponseStart['headers']['x-number']>().toEqualTypeOf<string | string[] | undefined>();
