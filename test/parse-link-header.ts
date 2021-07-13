import test from 'ava';
import parseLinkHeader from '../source/core/parse-link-header.js';

test('works as expected', t => {
	t.deepEqual(
		parseLinkHeader(
			'<https://one.example.com>; rel="preconnect", <https://two.example.com>; rel="preconnect", <https://three.example.com>; rel="preconnect"',
		),
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
		parseLinkHeader(
			'<https://one.example.com>; rel="previous"; title="previous chapter"',
		),
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
				// eslint-disable-next-line @typescript-eslint/quotes
				'title*': `UTF-8'de'letztes%20Kapitel`,
			},
		},
		{
			reference: '/TheBook/chapter4',
			parameters: {
				rel: '"next"',
				// eslint-disable-next-line @typescript-eslint/quotes
				'title*': `UTF-8'de'n%c3%a4chstes%20Kapitel`,
			},
		},
	]);

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
});
