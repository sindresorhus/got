import {expectTypeOf} from 'expect-type';
import got, {Options, type OptionsInit, type NormalizedOptions} from '../../source/index.js';

expectTypeOf<Options['url']>().toEqualTypeOf<URL | undefined>();
expectTypeOf<Options['prefixUrl']>().toEqualTypeOf<string>();
expectTypeOf<Extract<Options['cache'], boolean>>().toEqualTypeOf<never>();

const options = new Options('https://example.com/items');
options.url?.pathname.toUpperCase();
options.prefixUrl.endsWith('/');

options.url = 'https://example.com/changed';
options.url = new URL('https://example.com/changed');
options.url = undefined;
options.prefixUrl = 'https://example.com/api';
options.prefixUrl = new URL('https://example.com/api');
options.cache = true;
options.cache = false;

const input: OptionsInit = {
	url: 'https://example.com/items',
	prefixUrl: new URL('https://example.com'),
	cache: true,
};
expectTypeOf(new Options(undefined, input)).toEqualTypeOf<Options>();
options.merge({prefixUrl: new URL('https://example.com'), cache: false});

void got('https://example.com', {
	hooks: {
		beforeRequest: [(normalized: NormalizedOptions) => {
			normalized.url = 'https://example.com/changed';
			normalized.prefixUrl = new URL('https://example.com');
			normalized.cache = true;
			normalized.cache = false;
			normalized.url?.pathname.toUpperCase();
			normalized.prefixUrl.endsWith('/');
		}],
	},
});

void got.paginate.all('https://example.com', {
	pagination: {
		paginate: () => ({url: 'https://example.com/next', prefixUrl: new URL('https://example.com'), cache: true}),
	},
});
