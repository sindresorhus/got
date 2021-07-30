type Filter<K, I> = IfPrimitiveString<I, Equals<K, I> extends 1 ? never : K, K extends I ? never : K>;

export type Except<ObjectType, KeysType extends keyof ObjectType> = Pick<ObjectType, Exclude<keyof ObjectType, KeysType>>;
export type Merge<FirstType, SecondType> = Except<FirstType, Extract<keyof FirstType, keyof SecondType>> & SecondType;
export type Promisable<T> = T | Promise<T>;

type IfPrimitiveString<C, T, F> = string extends C ? T : F;
type EqualsTest<T> = <A>() => A extends T ? 1 : 0;
type Equals<A1, A2> = EqualsTest<A2> extends EqualsTest<A1> ? 1 : 0;

export type OmitIndex<T, I extends string | number> = {
	[K in keyof T as Filter<K, I>]: T[K];
};
