-- Part 1: Rename Tables
ALTER TABLE models RENAME TO entities;
ALTER TABLE models_shadow RENAME TO entities_shadow;
ALTER TABLE models_history RENAME TO entities_history;
