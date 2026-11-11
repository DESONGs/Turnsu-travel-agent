export const rendererVersions = Object.freeze({ itinerary: 1, map: 1, requirements: 1, places: 1 });
export function validateRenderers(contract, renderers = rendererVersions) {
  const components = contract.components;
  if (Object.keys(renderers).length !== components.length || components.some(c => renderers[c.type] !== c.version))
    throw new Error("旅行组件与页面版本不一致，请重新构建工作台。");
}
