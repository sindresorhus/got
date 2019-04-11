export default (mod: NodeModule, request: string): any => {
	return mod.require(request);
};
