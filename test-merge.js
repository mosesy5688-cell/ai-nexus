// Test Object.assign merging priority
const entityPack = {
    id: "test",
    description: "", // Engine 1 has empty string
    relations: [],   // Engine 1 has empty array
    fni_score: 0     // Engine 1 has default 0
};

const innerEntity = {
    id: "test",
    description: "Full description from Engine 2",
    relations: [{ target: "X" }],
    fni_score: 95,
    html_readme: "<h1>Hello</h1>"
};

const recoveredHtml = innerEntity.html_readme;

Object.assign(entityPack, {
    ...innerEntity,
    ...entityPack, // VFS original data takes precedence for structural markers
    html_readme: recoveredHtml,
    id: entityPack.id || innerEntity.id,
    type: entityPack.type || innerEntity.type
});

console.log("Merged entityPack:");
console.log("- description:", entityPack.description);
console.log("- relations:", entityPack.relations);
console.log("- fni_score:", entityPack.fni_score);
