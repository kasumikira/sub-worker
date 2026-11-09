let dynamicFunctionFactory;

export function registerDynamicFunctionFactory(factory) {
    dynamicFunctionFactory = factory;
}

export function getDynamicFunctionFactory() {
    return dynamicFunctionFactory;
}
