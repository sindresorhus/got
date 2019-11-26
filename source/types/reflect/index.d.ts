// The type-guarding behaviour is currently not supported as of TypeScript 3.7
// https://github.com/microsoft/TypeScript/issues/30688
declare namespace Reflect {
	function has<T extends object, Key extends PropertyKey>(target: T, propertyKey: Key): target is Required<Extract<T, {[key: Key]: any}>>;
}
