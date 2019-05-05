export default (moduleObject: NodeModule, moduleId: string): any => {
	return moduleObject.require(moduleId);
};
