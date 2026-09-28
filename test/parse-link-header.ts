import assert from 'node:assert/strict';
import parseLinkHeader from '../source/core/parse-link-header.js';
import test from './helpers/test.js';

// Every `parameters` object is built with a null prototype, so a header cannot store a name that is
// inherited from `Object.prototype`. `deepStrictEqual` compares prototypes, so the expectations have
// to carry the same one. A dedicated test below asserts the null prototype on its own.
const parameters = (value: Record<string, string>) => Object.assign(Object.create(null) as Record<string, string>, value);

test('works as expected', _t => {
	assert.deepStrictEqual(
		parseLinkHeader('<https://one.example.com>; rel="preconnect", <https://two.example.com>; rel="preconnect", <https://three.example.com>; rel="preconnect"'),
		[
			{
				reference: 'https://one.example.com',
				parameters: parameters({rel: '"preconnect"'}),
			},
			{
				reference: 'https://two.example.com',
				parameters: parameters({rel: '"preconnect"'}),
			},
			{
				reference: 'https://three.example.com',
				parameters: parameters({rel: '"preconnect"'}),
			},
		],
	);

	assert.deepStrictEqual(
		parseLinkHeader('<https://one.example.com>; rel="previous"; title="previous chapter"'),
		[
			{
				reference: 'https://one.example.com',
				parameters: parameters({rel: '"previous"', title: '"previous chapter"'}),
			},
		],
	);

	assert.deepStrictEqual(
		parseLinkHeader('</>; rel="http://example.net/foo"'),
		[
			{
				reference: '/',
				parameters: parameters({rel: '"http://example.net/foo"'}),
			},
		],
	);

	assert.deepStrictEqual(
		parseLinkHeader('</terms>; rel="copyright"; anchor="#foo"'),
		[
			{
				reference: '/terms',
				parameters: parameters({rel: '"copyright"', anchor: '"#foo"'}),
			},
		],
	);

	assert.deepStrictEqual(parseLinkHeader(`</TheBook/chapter2>;
	rel="previous"; title*=UTF-8'de'letztes%20Kapitel,
	</TheBook/chapter4>;
	rel="next"; title*=UTF-8'de'n%c3%a4chstes%20Kapitel`), [
		{
			reference: '/TheBook/chapter2',
			parameters: parameters({
				rel: '"previous"',

				'title*': 'UTF-8\'de\'letztes%20Kapitel',
			}),
		},
		{
			reference: '/TheBook/chapter4',
			parameters: parameters({
				rel: '"next"',

				'title*': 'UTF-8\'de\'n%c3%a4chstes%20Kapitel',
			}),
		},
	]);

	assert.deepStrictEqual(
		parseLinkHeader('<https://example.com>; rel="next"; title="Chapter 1, part 2"'),
		[
			{
				reference: 'https://example.com',
				parameters: parameters({
					rel: '"next"',
					title: '"Chapter 1, part 2"',
				}),
			},
		],
	);

	assert.deepStrictEqual(
		parseLinkHeader('<https://example.com>; rel="next"; title="Chapter 1; part 2"'),
		[
			{
				reference: 'https://example.com',
				parameters: parameters({
					rel: '"next"',
					title: '"Chapter 1; part 2"',
				}),
			},
		],
	);

	assert.deepStrictEqual(
		parseLinkHeader(String.raw`<https://example.com>; rel="next"; title="Chapter \"1\", part 2; final"`),
		[
			{
				reference: 'https://example.com',
				parameters: parameters({
					rel: '"next"',
					title: String.raw`"Chapter \"1\", part 2; final"`,
				}),
			},
		],
	);

	assert.throws(() => parseLinkHeader('https://bad.example; rel="preconnect"'), {
		message: 'Invalid format of the Link header reference: https://bad.example',
	});

	assert.throws(() => parseLinkHeader('https://bad.example; rel'), {
		message: 'Invalid format of the Link header reference: https://bad.example',
	});

	assert.throws(() => parseLinkHeader('https://bad.example'), {
		message: 'Invalid format of the Link header reference: https://bad.example',
	});

	assert.deepStrictEqual(parseLinkHeader(''), []);

	assert.deepStrictEqual(parseLinkHeader('<https://example.com>; rel'), [
		{
			reference: 'https://example.com',
			parameters: parameters({rel: ''}),
		},
	]);

	assert.throws(() => parseLinkHeader('<https://bad.example>; '), {
		message: 'Failed to parse Link header: <https://bad.example>; ',
	});

	assert.throws(() => parseLinkHeader('<https://bad.example'), {
		message: 'Invalid format of the Link header reference: <https://bad.example',
	});

	assert.throws(() => parseLinkHeader('https://bad.example>'), {
		message: 'Invalid format of the Link header reference: https://bad.example>',
	});

	assert.throws(() => parseLinkHeader('<https://a.example, <https://b.example>; rel="next"'), {
		message: 'Invalid format of the Link header reference: <https://a.example, <https://b.example>',
	});

	assert.throws(() => parseLinkHeader('<https://example.com>; rel="next"; title="foo, bar'), {
		message: 'Failed to parse Link header: <https://example.com>; rel="next"; title="foo, bar',
	});
});

test('parses URI references containing commas', _t => {
	assert.deepStrictEqual(
		parseLinkHeader('<https://example.com/one,two>; rel="next"'),
		[
			{
				reference: 'https://example.com/one,two',
				parameters: parameters({
					rel: '"next"',
				}),
			},
		],
	);

	assert.deepStrictEqual(
		parseLinkHeader('<https://example.com/one,two>; rel="next", <https://example.com/three>; rel="last"'),
		[
			{
				reference: 'https://example.com/one,two',
				parameters: parameters({
					rel: '"next"',
				}),
			},
			{
				reference: 'https://example.com/three',
				parameters: parameters({
					rel: '"last"',
				}),
			},
		],
	);
});

test('parses quoted parameter values containing commas', _t => {
	assert.deepStrictEqual(
		parseLinkHeader('<https://example.com>; rel="next"; title="foo, bar", <https://example.com/2>; rel="last"'),
		[
			{
				reference: 'https://example.com',
				parameters: parameters({
					rel: '"next"',
					title: '"foo, bar"',
				}),
			},
			{
				reference: 'https://example.com/2',
				parameters: parameters({
					rel: '"last"',
				}),
			},
		],
	);
});

test('parses URI references containing semicolons', _t => {
	assert.deepStrictEqual(
		parseLinkHeader('<https://example.com/one;two>; rel="next"'),
		[
			{
				reference: 'https://example.com/one;two',
				parameters: parameters({
					rel: '"next"',
				}),
			},
		],
	);
});

test('allows links without parameters', _t => {
	// RFC 8288 section 3: `link-value = "<" URI-Reference ">" *( OWS ";" OWS link-param )`
	assert.deepStrictEqual(
		parseLinkHeader('<https://api.example.com/items?page=2>; rel="next", <https://api.example.com/favicon.ico>'),
		[
			{
				reference: 'https://api.example.com/items?page=2',
				parameters: parameters({rel: '"next"'}),
			},
			{
				reference: 'https://api.example.com/favicon.ico',
				parameters: parameters({}),
			},
		],
	);
});

test('allows parameters without a value', _t => {
	// RFC 8288 section 3: `link-param = token BWS [ "=" BWS ( token / quoted-string ) ]`
	assert.deepStrictEqual(
		parseLinkHeader('</style.css>; rel=preload; as=style; crossorigin, </items?page=2>; rel="next"'),
		[
			{
				reference: '/style.css',
				parameters: parameters({rel: 'preload', as: 'style', crossorigin: ''}),
			},
			{
				reference: '/items?page=2',
				parameters: parameters({rel: '"next"'}),
			},
		],
	);
});

test('keeps the first case-insensitive parameter value', _t => {
	assert.deepStrictEqual(
		parseLinkHeader('<https://example.com>; rel=next; REL=prev; title=first; TITLE=second'),
		[
			{
				reference: 'https://example.com',
				parameters: parameters({rel: 'next', title: 'first'}),
			},
		],
	);
});

test('parses parameter names matching object properties', _t => {
	assert.deepStrictEqual(
		parseLinkHeader('<https://example.com>; constructor=first; __proto__=second'),
		[
			{
				reference: 'https://example.com',
				parameters: parameters({
					constructor: 'first',
					['__proto__']: 'second',
				}),
			},
		],
	);
});

test('ignores empty members in a Link header list', _t => {
	assert.deepStrictEqual(parseLinkHeader(', </next>; rel="next", , </previous>; rel="prev",'), [
		{reference: '/next', parameters: parameters({rel: '"next"'})},
		{reference: '/previous', parameters: parameters({rel: '"prev"'})},
	]);
});

test('empty Link header lists contain no links', _t => {
	for (const link of ['', ' ', '\t', ',', ', ,', ' ,\t, ']) {
		assert.deepStrictEqual(parseLinkHeader(link), []);
	}
});

test('empty list members preserve commas inside links and quoted parameters', _t => {
	assert.deepStrictEqual(parseLinkHeader(', </items?a=1,2>; title="one, two"; rel=next,,'), [
		{reference: '/items?a=1,2', parameters: parameters({title: '"one, two"', rel: 'next'})},
	]);
});

test('empty URI references remain links rather than empty list members', _t => {
	assert.deepStrictEqual(parseLinkHeader(', <>; rel=self,'), [
		{reference: '', parameters: parameters({rel: 'self'})},
	]);
});

test('empty list members do not hide malformed links or parameters', _t => {
	assert.throws(() => parseLinkHeader(', </next>; rel=next, invalid,'), {
		message: 'Invalid format of the Link header reference: invalid',
	});
	assert.throws(() => parseLinkHeader(', </next>; ,'), {
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
	test(`preserves ${name} without resolving or decoding it`, _t => {
		assert.deepStrictEqual(parseLinkHeader(`<${reference}>; rel=next`), [
			{reference, parameters: parameters({rel: 'next'})},
		]);
	});
}

test('accepts HTTP whitespace around parameter names and equals signs', _t => {
	assert.deepStrictEqual(parseLinkHeader('\t</next> \t;\t ReL \t= \t"next" \t; title = "next page"\t'), [
		{reference: '/next', parameters: parameters({rel: '"next"', title: '"next page"'})},
	]);
});

test('preserves an explicitly empty quoted attribute', _t => {
	assert.deepStrictEqual(parseLinkHeader('</next>; rel=next; title=""; crossorigin'), [
		{reference: '/next', parameters: parameters({rel: 'next', title: '""', crossorigin: ''})},
	]);
});

test('quoted angle brackets do not absorb subsequent links', _t => {
	assert.deepStrictEqual(parseLinkHeader('</next>; title="a < b > c"; rel=next, </last>; rel=last'), [
		{reference: '/next', parameters: parameters({title: '"a < b > c"', rel: 'next'})},
		{reference: '/last', parameters: parameters({rel: 'last'})},
	]);
});

test('a quoted escaped backslash does not escape the closing quote', _t => {
	const title = String.raw`"directory \\"`;
	assert.deepStrictEqual(parseLinkHeader(`</next>; title=${title}; rel=next, </last>; rel=last`), [
		{reference: '/next', parameters: parameters({title, rel: 'next'})},
		{reference: '/last', parameters: parameters({rel: 'last'})},
	]);
});

test('quoted equals signs remain part of attribute values', _t => {
	assert.deepStrictEqual(parseLinkHeader('</next>; title="page=2; sort=created"; rel=next'), [
		{reference: '/next', parameters: parameters({title: '"page=2; sort=created"', rel: 'next'})},
	]);
});

test('preserves extended titles independently of their ASCII fallback', _t => {
	// RFC 8288 section 3.4.1 leaves title* decoding and preference to the application.
	const extendedTitle = 'UTF-8\'fr\'caf%C3%A9';
	assert.deepStrictEqual(parseLinkHeader(`</next>; title="cafe"; title*=${extendedTitle}; rel=next`), [
		{
			reference: '/next',
			parameters: parameters({
				title: '"cafe"',

				'title*': extendedTitle,
				rel: 'next',
			}),
		},
	]);
});

test('parameter state does not leak between links with the same target', _t => {
	assert.deepStrictEqual(parseLinkHeader('</items>; rel=next; title="next", </items>; rel=prev'), [
		{reference: '/items', parameters: parameters({rel: 'next', title: '"next"'})},
		{reference: '/items', parameters: parameters({rel: 'prev'})},
	]);
});

test('parameters have no prototype so a header can set an inherited name', _t => {
	const [entry] = parseLinkHeader('<https://example.com>; rel=next; constructor=own; __proto__=own');

	assert.strictEqual(Object.getPrototypeOf(entry!.parameters), null);
	// A null prototype lets an inherited name be stored as data instead of being swallowed.
	assert.deepStrictEqual(Object.keys(entry!.parameters).toSorted(), ['__proto__', 'constructor', 'rel']);
	assert.strictEqual(entry!.parameters.rel, 'next');
});

test('a rel parameter can list several relation types', _t => {
	assert.deepStrictEqual(parseLinkHeader('<https://example.com>; rel="next prev last"'), [
		{reference: 'https://example.com', parameters: parameters({rel: '"next prev last"'})},
	]);
});

test('an anchor parameter is preserved for callers to filter on', _t => {
	assert.deepStrictEqual(parseLinkHeader('<https://example.com/2>; rel=next; anchor="/feed"'), [
		{reference: 'https://example.com/2', parameters: parameters({rel: 'next', anchor: '"/feed"'})},
	]);
});

// Optional whitespace is allowed inside the angle brackets (RFC 8288, section 3).
for (const header of [
	'< https://example.com/2 >; rel="next"',
	'\t<https://example.com/2>\t; rel="next"',
]) {
	test(`strips the whitespace inside the reference brackets: ${JSON.stringify(header)}`, _t => {
		assert.deepStrictEqual(parseLinkHeader(header), [{
			reference: 'https://example.com/2',
			parameters: parameters({rel: '"next"'}),
		}]);
	});
}
