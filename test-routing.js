import { getRouteFromId, getTypeFromId, stripPrefix } from './src/utils/mesh-routing-core.js';

const testCases = [
    { id: 'asd1g1/microplastic-segmentation-dataset', expectedType: 'dataset', expectedRoute: '/dataset/asd1g1/microplastic-segmentation-dataset' },
    { id: 'dataset/alessandrolobello/agri-food-co2-emission-dataset-forecasting-ml', expectedType: 'dataset', expectedRoute: '/dataset/alessandrolobello/agri-food-co2-emission-dataset-forecasting-ml' },
    { id: 'kaggle--athina-ai--rag-cookbooks', expectedType: 'dataset', expectedRoute: '/dataset/athina-ai/rag-cookbooks' },
    { id: 'concept--rag', expectedType: 'knowledge', expectedRoute: '/knowledge/rag' }
];

console.log('--- Routing Verification V16.40 ---');
testCases.forEach(({ id, expectedType, expectedRoute }) => {
    const type = getTypeFromId(id);
    const route = getRouteFromId(id);
    const status = (type === expectedType && route === expectedRoute) ? '✅' : '❌';
    console.log(`${status} ID: ${id}`);
    console.log(`   Type: ${type} (Expected: ${expectedType})`);
    console.log(`   Route: ${route} (Expected: ${expectedRoute})`);
});
