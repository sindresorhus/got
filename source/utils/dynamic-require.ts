/* istanbul ignore file: used for webpack */

export default (moduleObject: NodeModule, moduleId: string): unknown => moduleObject.require(moduleId);
