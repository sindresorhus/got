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

	t.deepEqual(parseLinkHeader(''), []);

	t.deepEqual(parseLinkHeader('<https://example.com>; rel'), [
		{
			reference: 'https://example.com',
			parameters: {rel: ''},
		},
	]);

	t.throws(() => parseLinkHeader('<https://bad.example>; '), {
		message: 'Failed to parse Link header: <https://bad.example>; ',
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

test('allows links without parameters', t => {
	// RFC 8288 section 3: `link-value = "<" URI-Reference ">" *( OWS ";" OWS link-param )`
	t.deepEqual(
		parseLinkHeader('<https://api.example.com/items?page=2>; rel="next", <https://api.example.com/favicon.ico>'),
		[
			{
				reference: 'https://api.example.com/items?page=2',
				parameters: {rel: '"next"'},
			},
			{
				reference: 'https://api.example.com/favicon.ico',
				parameters: {},
			},
		],
	);
});

test('allows parameters without a value', t => {
	// RFC 8288 section 3: `link-param = token BWS [ "=" BWS ( token / quoted-string ) ]`
	t.deepEqual(
		parseLinkHeader('</style.css>; rel=preload; as=style; crossorigin, </items?page=2>; rel="next"'),
		[
			{
				reference: '/style.css',
				parameters: {rel: 'preload', as: 'style', crossorigin: ''},
			},
			{
				reference: '/items?page=2',
				parameters: {rel: '"next"'},
			},
		],
	);
});

test('keeps the first case-insensitive parameter value', t => {
	t.deepEqual(
		parseLinkHeader('<https://example.com>; rel=next; REL=prev; title=first; TITLE=second'),
		[
			{
				reference: 'https://example.com',
				parameters: {rel: 'next', title: 'first'},
			},
		],
	);
});

test('parses parameter names matching object properties', t => {
	t.deepEqual(
		parseLinkHeader('<https://example.com>; constructor=first; __proto__=second'),
		[
			{
				reference: 'https://example.com',
				parameters: {
					constructor: 'first',
					['__proto__']: 'second',
				},
			},
		],
	);
});

test('ignores empty members in a Link header list', t => {
	t.deepEqual(parseLinkHeader(', </next>; rel="next", , </previous>; rel="prev",'), [
		{reference: '/next', parameters: {rel: '"next"'}},
		{reference: '/previous', parameters: {rel: '"prev"'}},
	]);
});

test('empty Link header lists contain no links', t => {
	for (const link of ['', ' ', '\t', ',', ', ,', ' ,\t, ']) {
		t.deepEqual(parseLinkHeader(link), []);
	}
});

test('empty list members preserve commas inside links and quoted parameters', t => {
	t.deepEqual(parseLinkHeader(', </items?a=1,2>; title="one, two"; rel=next,,'), [
		{reference: '/items?a=1,2', parameters: {title: '"one, two"', rel: 'next'}},
	]);
});

test('empty URI references remain links rather than empty list members', t => {
	t.deepEqual(parseLinkHeader(', <>; rel=self,'), [
		{reference: '', parameters: {rel: 'self'}},
	]);
});

test('empty list members do not hide malformed links or parameters', t => {
	t.throws(() => parseLinkHeader(', </next>; rel=next, invalid,'), {
		message: 'Invalid format of the Link header reference: invalid',
	});
	t.throws(() => parseLinkHeader(', </next>; ,'), {
		message: 'Failed to parse Link header: , </next>; ,',
	});
});

// RFC 8288 section 3 permits quoted-string values and preserves URI references for the application to resolve.
for (const {name, reference} of [
	{name: 'query-only target', reference: '?page=2&sort=created'},
	{name: 'fragment-only target', reference: '#details'},
	{name: 'parent-relative target', reference: '../items?page=2'},
	{name: 'network-path target', reference: '//api.example.com/items'},
	{name: 'percent-encoded delimiters', reference: '/items%2Fpart?query=%3B%2C%3D'},
]) {
	test(`preserves ${name} without resolving or decoding it`, t => {
		t.deepEqual(parseLinkHeader(`<${reference}>; rel=next`), [
			{reference, parameters: {rel: 'next'}},
		]);
	});
}

test('accepts HTTP whitespace around parameter names and equals signs', t => {
	t.deepEqual(parseLinkHeader('\t</next> \t;\t ReL \t= \t"next" \t; title = "next page"\t'), [
		{reference: '/next', parameters: {rel: '"next"', title: '"next page"'}},
	]);
});

test('preserves an explicitly empty quoted attribute', t => {
	t.deepEqual(parseLinkHeader('</next>; rel=next; title=""; crossorigin'), [
		{reference: '/next', parameters: {rel: 'next', title: '""', crossorigin: ''}},
	]);
});

test('quoted angle brackets do not absorb subsequent links', t => {
	t.deepEqual(parseLinkHeader('</next>; title="a < b > c"; rel=next, </last>; rel=last'), [
		{reference: '/next', parameters: {title: '"a < b > c"', rel: 'next'}},
		{reference: '/last', parameters: {rel: 'last'}},
	]);
});

test('a quoted escaped backslash does not escape the closing quote', t => {
	const title = String.raw`"directory \\"`;
	t.deepEqual(parseLinkHeader(`</next>; title=${title}; rel=next, </last>; rel=last`), [
		{reference: '/next', parameters: {title, rel: 'next'}},
		{reference: '/last', parameters: {rel: 'last'}},
	]);
});

test('quoted equals signs remain part of attribute values', t => {
	t.deepEqual(parseLinkHeader('</next>; title="page=2; sort=created"; rel=next'), [
		{reference: '/next', parameters: {title: '"page=2; sort=created"', rel: 'next'}},
	]);
});

test('preserves extended titles independently of their ASCII fallback', t => {
	// RFC 8288 section 3.4.1 leaves title* decoding and preference to the application.
	const extendedTitle = 'UTF-8\'fr\'caf%C3%A9';
	t.deepEqual(parseLinkHeader(`</next>; title="cafe"; title*=${extendedTitle}; rel=next`), [
		{
			reference: '/next',
			parameters: {
				title: '"cafe"',
				// eslint-disable-next-line @typescript-eslint/naming-convention
				'title*': extendedTitle,
				rel: 'next',
			},
		},
	]);
});

test('parameter state does not leak between links with the same target', t => {
	t.deepEqual(parseLinkHeader('</items>; rel=next; title="next", </items>; rel=prev'), [
		{reference: '/items', parameters: {rel: 'next', title: '"next"'}},
		{reference: '/items', parameters: {rel: 'prev'}},
	]);
});
