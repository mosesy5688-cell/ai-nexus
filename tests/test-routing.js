import { stripPrefix, getRouteFromId } from '../src/utils/mesh-routing-core.js';

const testIds = [
    'hf-model--coqui--xtts-v2',
    'gh-model--berniwal--swin-transformer-pytorch',
    'gh-model/berniwal/swin-transformer-pytorch',
    'github--berniwal--swin-transformer-pytorch'
];

testIds.forEach(id => {
    console.log(`ID: ${id}`);
    console.log(`  stripPrefix: ${stripPrefix(id)}`);
    console.log(`  getRouteFromId: ${getRouteFromId(id, 'model')}`);
});
