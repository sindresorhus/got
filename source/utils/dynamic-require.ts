export default (moduleObject: NodeModule, moduleId: string): unknown => {
	return moduleObject.require(moduleId);
};
