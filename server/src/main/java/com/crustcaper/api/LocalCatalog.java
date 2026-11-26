package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.*;

import java.util.List;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

@Component
@Profile("local & !stage & !prod & !production")
@ConditionalOnProperty(name = "crustcaper.payment.provider", havingValue = "local")
class LocalCatalog implements CommandLineRunner {
    private static final String STORE = "kigali";
    private static final List<Localized> BURGER_ALLERGENS = List.of(
        text("Wheat", "Ingano"), text("Milk", "Amata"), text("Egg", "Amagi"), text("Mustard", "Moutarde"));
    private static final List<Modifier> BURGER_OPTIONS = List.of(
        new Modifier("extra-cheese", text("Extra cheese", "Foromaje y’inyongera"), 500),
        new Modifier("no-pickles", text("No pickles", "Nta concombre"), 0));
    private static final List<Product> MENU = List.of(
        product("classic-smash", "burgers", 6900, "Classic Smash", "Classic Smash",
            "Smashed beef and cheese on a toasted bun.", "Inyama z’inka na foromaje mu mugati.", BURGER_OPTIONS),
        product("double-smash", "burgers", 9200, "Double Smash", "Double Smash",
            "Two beef patties, double cheese and house sauce.", "Inyama z’inka ebyiri, foromaje n’isosi.", BURGER_OPTIONS),
        product("caper-heat", "burgers", 9900, "Caper Heat", "Caper Heat",
            "Two beef patties with a hot caper dressing.", "Inyama z’inka n’isosi y’urusenda.", BURGER_OPTIONS),
        product("crispy-chicken", "burgers", 8300, "Crispy Chicken", "Crispy Chicken",
            "Crispy chicken fillet, slaw and sauce.", "Inyama z’inkoko, amashu n’isosi.", BURGER_OPTIONS),
        product("veggie-crunch", "burgers", 7800, "Veggie Crunch", "Veggie Crunch",
            "Vegetable patty with slaw and sauce.", "Akabumbe k’imboga, amashu n’isosi.", BURGER_OPTIONS),
        product("double-combo", "combos", 12400, "Double Combo", "Double Combo",
            "Double Smash with fries and a cold drink.", "Double Smash, ibirayi n’ikinyobwa.", BURGER_OPTIONS),
        product("lunch-smash", "combos", 7900, "Lunch Smash", "Lunch Smash",
            "Classic Smash with fries.", "Classic Smash n’ibirayi.", BURGER_OPTIONS),
        product("fries", "sides", 2500, "Golden Fries", "Ibirayi bikaranze",
            "Crisp fries with sea salt.", "Ibirayi bikaranze birimo umunyu.", List.of()),
        product("soft-drink", "drinks", 1500, "Soft Drink", "Ikinyobwa kidasembuye",
            "A chilled soft drink.", "Ikinyobwa gikonje kidasembuye.", List.of())
    );

    private final JdbcClient jdbc;
    private final CommerceJson json;

    LocalCatalog(JdbcClient jdbc, CommerceJson json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Override
    @Transactional
    public void run(String... arguments) {
        // The importer uses this lock even before a store row exists.
        jdbc.sql("SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('crustcaper:catalog:' || ?, 0))")
            .param(STORE).query(Integer.class).single();
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            VALUES (?, CAST(? AS jsonb), CAST(? AS jsonb), CAST(? AS jsonb), true, 1800, 'local-1')
            ON CONFLICT (id) DO NOTHING
            """).params(STORE, json.write(text("CrustCaper Kigali", "CrustCaper Kigali")),
                json.write(text("Kigali, Rwanda", "Kigali, u Rwanda")),
                json.write(text("Local test location", "Aho kugeragereza")))
            .update();
        // Coordinate fixture seeding with shift publication and catalog imports.
        jdbc.sql("SELECT id FROM stores WHERE id = ? FOR UPDATE").param(STORE).query(String.class).single();
        for (int position = 0; position < MENU.size(); position++) {
            Product product = MENU.get(position);
            jdbc.sql("""
                INSERT INTO menu_products (store_id, sku, position, product)
                VALUES (?, ?, ?, CAST(? AS jsonb)) ON CONFLICT (store_id, sku) DO NOTHING
                """).params(STORE, product.sku(), position, json.write(product)).update();
        }
        jdbc.sql("""
            WITH base AS (
                SELECT date_trunc('hour', now())
                    + (floor(extract(minute FROM now()) / 10) + 1) * interval '10 min' AS starts
            )
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            SELECT ?, 'slot-' || extract(epoch FROM slot_start)::bigint,
                slot_start, slot_start + interval '10 min', 4
            FROM base, generate_series(base.starts, base.starts + interval '7 days', interval '10 min') AS slot_start
            WHERE NOT EXISTS (
                SELECT 1 FROM pickup_slots saved WHERE saved.store_id = ?
                    AND saved.starts_at < slot_start + interval '10 min' AND saved.ends_at > slot_start
            )
            ON CONFLICT (store_id, id) DO NOTHING
            """).params(STORE, STORE).update();
    }

    private static Product product(String sku, String category, long price, String en, String rw,
                                   String descriptionEn, String descriptionRw, List<Modifier> modifiers) {
        return new Product(sku, text(en, rw), text(descriptionEn, descriptionRw), List.of(),
            modifiers.isEmpty() ? List.of() : BURGER_ALLERGENS, category, price, true, modifiers, null);
    }

    private static Localized text(String en, String rw) {
        return new Localized(en, rw);
    }
}
