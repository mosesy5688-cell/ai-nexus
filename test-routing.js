import { getRouteFromId, getTypeFromId, stripPrefix } from './src/utils/mesh-routing-core.js';

const testCases = [
    { id: 'ashishbadal18/32000-songs-ragas-mental-health-classification', expectedType: 'dataset', expectedRoute: '/dataset/ashishbadal18/32000-songs-ragas-mental-health-classification' },
    { id: 'asd1g1/microplastic-segmentation-dataset', expectedType: 'dataset', expectedRoute: '/dataset/asd1g1/microplastic-segmentation-dataset' },
    { id: 'dataset/alessandrolobello/agri-food-co2-emission-dataset-forecasting-ml', expectedType: 'dataset', expectedRoute: '/dataset/alessandrolobello/agri-food-co2-emission-dataset-forecasting-ml' }
];

console.log('--- Routing Verification V16.42 ---');
testCases.forEach(({ id, expectedType, expectedRoute }) => {
    const type = getTypeFromId(id);
    const route = getRouteFromId(id);
    const status = (type === expectedType && route === expectedRoute) ? '✅' : '❌';
    console.log(`${status} ID: ${id}`);
    console.log(`   Type: ${type} (Expected: ${expectedType})`);
    console.log(`   Route: ${route} (Expected: ${expectedRoute})`);
});
