export default (moduleObject: NodeModule, request: moduleId): unknown => {
	return moduleObject.require(moduleId);
};
