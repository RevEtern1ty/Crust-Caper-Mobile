ALTER TABLE menu_products
    ADD COLUMN recipe_version text CHECK (recipe_version ~ '^[A-Za-z0-9._:-]{1,100}$'),
    ADD COLUMN allergen_version text CHECK (allergen_version ~ '^[A-Za-z0-9._:-]{1,100}$'),
    ADD CONSTRAINT menu_product_recipe_versions_pair CHECK ((recipe_version IS NULL) = (allergen_version IS NULL));

CREATE TABLE catalog_recipe_approvals (
    store_id text NOT NULL REFERENCES stores(id),
    expected_version text NOT NULL CHECK (expected_version ~ '^[A-Za-z0-9._:-]{1,100}$'),
    catalog_version text NOT NULL CHECK (catalog_version ~ '^[A-Za-z0-9._:-]{1,100}$'),
    sku text NOT NULL CHECK (sku ~ '^[A-Za-z0-9._:-]{1,100}$'),
    facts jsonb NOT NULL CHECK (
        jsonb_typeof(facts) = 'object'
        AND facts ?& ARRAY['recipeVersion', 'allergenVersion', 'ingredients', 'allergens']
        AND facts - ARRAY['recipeVersion', 'allergenVersion', 'ingredients', 'allergens'] = '{}'::jsonb
        AND jsonb_typeof(facts->'recipeVersion') = 'string' AND (facts->>'recipeVersion') ~ '^[A-Za-z0-9._:-]{1,100}$'
        AND jsonb_typeof(facts->'allergenVersion') = 'string' AND (facts->>'allergenVersion') ~ '^[A-Za-z0-9._:-]{1,100}$'
        AND jsonb_typeof(facts->'ingredients') = 'array'
        AND jsonb_typeof(facts->'allergens') = 'array'
    ),
    operator_id uuid NOT NULL REFERENCES operator_accounts(id),
    approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    applied_at timestamptz,
    PRIMARY KEY (store_id, expected_version, catalog_version, sku),
    CHECK (expected_version <> catalog_version),
    CHECK (applied_at IS NULL OR applied_at >= approved_at)
);
