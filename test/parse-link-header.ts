import test from 'ava';
import parseLinkHeader from '../source/core/parse-link-header.js';

test('works as expected', t => {
	t.deepEqual(
		parseLinkHeader('<https://one.example.com>; rel="preconnect", <https://two.example.com>; rel="preconnect", <https://three.example.com>; rel="preconnect"'),
		[
			{
				reference: 'https://one.example.com',
				parameters: {rel: '"preconnect"'},
			},
			{
				reference: 'https://two.example.com',
				parameters: {rel: '"preconnect"'},
			},
			{
				reference: 'https://three.example.com',
				parameters: {rel: '"preconnect"'},
			},
		],
	);

	t.deepEqual(
		parseLinkHeader('<https://one.example.com>; rel="previous"; title="previous chapter"'),
		[
			{
				reference: 'https://one.example.com',
				parameters: {rel: '"previous"', title: '"previous chapter"'},
			},
		],
	);

	t.deepEqual(
		parseLinkHeader('</>; rel="http://example.net/foo"'),
		[
			{
				reference: '/',
				parameters: {rel: '"http://example.net/foo"'},
			},
		],
	);

	t.deepEqual(
		parseLinkHeader('</terms>; rel="copyright"; anchor="#foo"'),
		[
			{
				reference: '/terms',
				parameters: {rel: '"copyright"', anchor: '"#foo"'},
			},
		],
	);

	t.deepEqual(parseLinkHeader(`</TheBook/chapter2>;
	rel="previous"; title*=UTF-8'de'letztes%20Kapitel,
	</TheBook/chapter4>;
	rel="next"; title*=UTF-8'de'n%c3%a4chstes%20Kapitel`), [
		{
			reference: '/TheBook/chapter2',
			parameters: {
				rel: '"previous"',
				// eslint-disable-next-line @typescript-eslint/naming-convention
				'title*': 'UTF-8\'de\'letztes%20Kapitel',
			},
		},
		{
			reference: '/TheBook/chapter4',
			parameters: {
				rel: '"next"',
				// eslint-disable-next-line @typescript-eslint/naming-convention
				'title*': 'UTF-8\'de\'n%c3%a4chstes%20Kapitel',
			},
		},
	]);

	t.deepEqual(
		parseLinkHeader('<https://example.com>; rel="next"; title="Chapter 1, part 2"'),
		[
			{
				reference: 'https://example.com',
				parameters: {
					rel: '"next"',
					title: '"Chapter 1, part 2"',
				},
			},
		],
	);

	t.deepEqual(
		parseLinkHeader('<https://example.com>; rel="next"; title="Chapter 1; part 2"'),
		[
			{
				reference: 'https://example.com',
				parameters: {
					rel: '"next"',
					title: '"Chapter 1; part 2"',
				},
			},
		],
	);

	t.deepEqual(
		parseLinkHeader(String.raw`<https://example.com>; rel="next"; title="Chapter \"1\", part 2; final"`),
		[
			{
				reference: 'https://example.com',
				parameters: {
					rel: '"next"',
					title: String.raw`"Chapter \"1\", part 2; final"`,
				},
			},
		],
	);

	t.throws(() => parseLinkHeader('https://bad.example; rel="preconnect"'), {
		message: 'Invalid format of the Link header reference: https://bad.example',
	});

	t.throws(() => parseLinkHeader('https://bad.example; rel'), {
		message: 'Invalid format of the Link header reference: https://bad.example',
	});

	t.throws(() => parseLinkHeader('https://bad.example'), {
		message: 'Invalid format of the Link header reference: https://bad.example',
	});

	t.throws(() => parseLinkHeader(''), {
		message: 'Invalid format of the Link header reference: ',
	});

	t.throws(() => parseLinkHeader('<https://bad.example>; rel'), {
		message: 'Failed to parse Link header: <https://bad.example>; rel',
	});

	t.throws(() => parseLinkHeader('<https://bad.example>'), {
		message: 'Unexpected end of Link header parameters: ',
	});

	t.throws(() => parseLinkHeader('<>'), {
		message: 'Unexpected end of Link header parameters: ',
	});

	t.throws(() => parseLinkHeader('<https://bad.example'), {
		message: 'Invalid format of the Link header reference: <https://bad.example',
	});

	t.throws(() => parseLinkHeader('https://bad.example>'), {
		message: 'Invalid format of the Link header reference: https://bad.example>',
	});

	t.throws(() => parseLinkHeader('<https://a.example, <https://b.example>; rel="next"'), {
		message: 'Invalid format of the Link header reference: <https://a.example, <https://b.example>',
	});

	t.throws(() => parseLinkHeader('<https://example.com>; rel="next"; title="foo, bar'), {
		message: 'Failed to parse Link header: <https://example.com>; rel="next"; title="foo, bar',
	});
});

test('parses URI references containing commas', t => {
	t.deepEqual(
		parseLinkHeader('<https://example.com/one,two>; rel="next"'),
		[
			{
				reference: 'https://example.com/one,two',
				parameters: {
					rel: '"next"',
				},
			},
		],
	);

	t.deepEqual(
		parseLinkHeader('<https://example.com/one,two>; rel="next", <https://example.com/three>; rel="last"'),
		[
			{
				reference: 'https://example.com/one,two',
				parameters: {
					rel: '"next"',
				},
			},
			{
				reference: 'https://example.com/three',
				parameters: {
					rel: '"last"',
				},
			},
		],
	);
});

test('parses quoted parameter values containing commas', t => {
	t.deepEqual(
		parseLinkHeader('<https://example.com>; rel="next"; title="foo, bar", <https://example.com/2>; rel="last"'),
		[
			{
				reference: 'https://example.com',
				parameters: {
					rel: '"next"',
					title: '"foo, bar"',
				},
			},
			{
				reference: 'https://example.com/2',
				parameters: {
					rel: '"last"',
				},
			},
		],
	);
});

test('parses URI references containing semicolons', t => {
	t.deepEqual(
		parseLinkHeader('<https://example.com/one;two>; rel="next"'),
		[
			{
				reference: 'https://example.com/one;two',
				parameters: {
					rel: '"next"',
				},
			},
		],
	);
});
