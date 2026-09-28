/**
Thin compatibility layer over the built-in runner.

`node:test` has no macro support, but most of this suite needs a server, a prepared `got` instance and
sometimes fake timers injected into the test body. This module keeps those call sites on the
`test('title', macro, async (t, server, got) => {})` shape while the assertions themselves use
`node:assert` directly.

The context handed to a test body is the real `node:test` context, so `t.after`, `t.diagnostic` and
mock tracking behave natively.
*/

import {
	test as nodeTest,
	before,
	afterEach,
	type TestContext,
} from 'node:test';

/**
A test body. It receives the runner context first, then whatever the macro injects.

The extra parameters are the macro's own, so they stay inferred at the call site rather than
degrading to `any`.
*/
export type TestBody<Arguments extends any[] = any[]> =
	(t: TestContext, ...arguments_: Arguments) => Promise<void> | void;

/**
The macro protocol: it receives the runner context followed by the test body, and is free to set up
and tear down around it.

A macro is also callable directly, as `withServer(t, body)`, which is how a test nests one server
inside another.
*/
export type Macro<Arguments extends any[] = any[]> =
	(t: TestContext, run: TestBody<Arguments>) => Promise<void> | void;

/**
A macro that supplies the test body itself instead of receiving one, so the registration passes the
macro only its own arguments. `register` calls the first function after the title with the context
followed by those arguments, which is the same call for both macro kinds.
*/
export type StandaloneMacro<Arguments extends any[] = any[]> =
	(t: TestContext, ...arguments_: Arguments) => Promise<void> | void;

/**
Runner options. They go before the macro: `test(title, {timeout}, macro, body)`.
*/
export type TestOptions = {timeout?: number; skip?: boolean | string};

/**
A macro is a function, so it cannot be told apart from a body by type alone. The runner only ever
calls it, so the distinction only matters for the parameter types, and those line up either way.
*/
type Callable = (t: TestContext, ...arguments_: any[]) => Promise<void> | void;

const register = (
	variant: typeof nodeTest | typeof nodeTest.skip,
	title: string,
	rest: any[],
) => {
	// `test(title, body)`, `test(title, options, body)` and `test(title, macro, ...arguments)`.
	const isOptions = rest[0] !== null && typeof rest[0] === 'object';
	const options: TestOptions = isOptions ? rest[0] : {};
	const [macroOrBody, ...arguments_] = isOptions ? rest.slice(1) : rest;

	if (typeof macroOrBody !== 'function') {
		throw new TypeError(`Expected a test body or macro, got \`${typeof macroOrBody}\``);
	}

	// A macro call is `test(title, macro, ...arguments)`, and a plain call is `test(title, body)`.
	// Both hand the context to their first argument followed by the rest, so one shape covers them.
	return variant(title, options, t => (macroOrBody as Callable)(t, ...arguments_));
};

/**
Registers a test.

The overloads are what give each test body its parameter types. A macro declares the arguments it
injects, so a macro call infers its body from that; without a macro the body only takes the
context, so its own signature is the only source of types.
*/
function runTest<Arguments extends any[]>(title: string, macro: Macro<Arguments>, body: TestBody<Arguments>, ...rest: any[]): void;
/**
A macro that carries out the assertion itself takes its own arguments rather than a body, so the
arguments are bound contextually here.
*/
function runTest<Arguments extends any[]>(title: string, macro: ((t: TestContext, ...arguments_: Arguments) => Promise<void>) | StandaloneMacro<Arguments>, ...arguments_: Arguments): void;
function runTest<Arguments extends any[]>(title: string, options: TestOptions, macro: Macro<Arguments>, body: TestBody<Arguments>, ...rest: any[]): void;
function runTest<Arguments extends any[]>(title: string, body: TestBody<Arguments>): void;
function runTest(title: string, ...rest: any[]) {
	return register(nodeTest, title, rest);
}

/**
Registers a test that the runner reports as skipped. The body is still typed the same way, so a
skipped test needs no separate signature.
*/
function runTestSkipping<Arguments extends any[]>(title: string, macro: Macro<Arguments>, body: TestBody<Arguments>, ...rest: any[]): void;
function runTestSkipping<Arguments extends any[]>(title: string, options: TestOptions, macro: Macro<Arguments>, body: TestBody<Arguments>, ...rest: any[]): void;
function runTestSkipping<Arguments extends any[]>(title: string, body: TestBody<Arguments>): void;
function runTestSkipping<Arguments extends any[]>(title: string, options: TestOptions, body: TestBody<Arguments>): void;
function runTestSkipping<Arguments extends any[]>(title: string, macro: StandaloneMacro<Arguments>, ...arguments_: Arguments): void;
function runTestSkipping(title: string, ...rest: any[]) {
	return register(nodeTest.skip, title, rest);
}

/**
AVAs `test.failing` asserts that the body fails. The runner has no equivalent, so the expectation is
inverted: the body has to throw, and passing is what fails the test.
*/
function failingTest<Arguments extends any[]>(title: string, macro: Macro<Arguments>, body: TestBody<Arguments>, ...rest: any[]): void;
function failingTest<Arguments extends any[]>(title: string, body: TestBody<Arguments>): void;
function failingTest(title: string, ...rest: any[]) {
	const [optionsOrMacro, ...tail] = rest;
	const isOptions = optionsOrMacro !== null && typeof optionsOrMacro === 'object';
	const options = isOptions ? optionsOrMacro as TestOptions : {};
	const macroOrBody = isOptions ? tail[0] : optionsOrMacro;
	const arguments_ = isOptions ? tail.slice(1) : tail;

	return register(nodeTest, title, [
		options,
		async (t: TestContext, ...bodyArguments: any[]) => {
			try {
				await (macroOrBody as Callable)(t, ...bodyArguments);
			} catch {
				return;
			}

			throw new Error(`Expected \`${title}\` to fail, but it passed`);
		},
		...arguments_,
	]);
}

export const test = Object.assign(runTest, {
	/**
	`node:test` runs the top-level tests of a file sequentially, so serial is already the default.
	*/
	serial: runTest,

	skip: runTestSkipping,

	failing: failingTest,

	/**
	Build a reusable macro out of a function. A macro may take the body as its second parameter, or
	take extra arguments of its own and call the body itself.
	*/
	macro: (macro: any) => macro,

	/**
	Registers a hook that runs before the file's tests. The runner hooks take only a function, while
	these call sites pass a name as well, so the name is accepted and dropped.
	*/
	before(nameOrFunction: string | (() => unknown | Promise<unknown>), maybeFunction?: () => unknown | Promise<unknown>) {
		before(typeof nameOrFunction === 'function' ? nameOrFunction : maybeFunction);
	},

	afterEach,
});

export default test;
