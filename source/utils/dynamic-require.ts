export default (moduleId: string, moduleObject: NodeModule = module): unknown => {
	return moduleObject.require(moduleId);
};
