package app.travelagent.core;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** A partial tally of user-recorded prices; no exchange rate or missing trip cost is invented. */
final class RecordedTransportBudget {
    private RecordedTransportBudget() {}

    static Map<String, Object> summarize(Object rawFacts, Object rawBudget) {
        if (!(rawFacts instanceof List<?> facts) || !(rawBudget instanceof Map<?, ?> budget)) throw new TravelError("invalid_transport_fact");
        var totals = new TreeMap<String, BigDecimal>();
        int missing = 0, uncertainTaxes = 0, sharedPrices = 0;
        for (Object value : facts) {
            if (!(value instanceof Map<?, ?> fact)) throw new TravelError("invalid_transport_fact");
            if (fact.get("price") == null) { missing++; continue; }
            if (!(fact.get("price") instanceof Map<?, ?> price) || !(price.get("amount") instanceof String amountText)
                    || !(price.get("currency") instanceof String currency) || !(price.get("unit") instanceof String unit)
                    || !(price.get("taxes") instanceof String taxes) || !(fact.get("travelerIds") instanceof List<?> people))
                throw new TravelError("invalid_transport_price");
            BigDecimal amount;
            try { amount = new BigDecimal(amountText); } catch (RuntimeException invalid) { throw new TravelError("invalid_transport_price"); }
            if (amount.signum() < 0 || !List.of("total", "per_person").contains(unit) || !List.of("included", "excluded", "unknown").contains(taxes)) throw new TravelError("invalid_transport_price");
            if (!"included".equals(taxes)) uncertainTaxes++;
            if (!"segment".equals(price.get("coverage"))) { sharedPrices++; continue; }
            if ("per_person".equals(unit) && people.isEmpty()) { missing++; continue; }
            BigDecimal total = "per_person".equals(unit) ? amount.multiply(BigDecimal.valueOf(people.size())) : amount;
            totals.merge(currency, total, BigDecimal::add);
        }
        var currencies = new ArrayList<Map<String, Object>>();
        totals.forEach((currency, amount) -> currencies.add(Map.of("currency", currency, "amount", amount.stripTrailingZeros().toPlainString())));
        String budgetCurrency = budget.get("currency") instanceof String text ? text : "";
        Object limit = budget.get("totalBudget");
        String comparison = "no_budget";
        if (limit instanceof Number number) {
            BigDecimal target;
            try { target = new BigDecimal(number.toString()); } catch (RuntimeException invalid) { throw new TravelError("invalid_budget"); }
            comparison = totals.getOrDefault(budgetCurrency, BigDecimal.ZERO).compareTo(target) > 0 ? "recorded_transport_exceeds_budget" : "incomplete";
        } else if (limit != null) throw new TravelError("invalid_budget");
        var otherCurrencies = totals.keySet().stream().filter(currency -> !currency.equals(budgetCurrency)).toList();
        return Map.of("currencyTotals", currencies, "missingPriceOrPassengers", missing, "sharedPrices", sharedPrices, "uncertainTaxes", uncertainTaxes,
                "unconvertedCurrencies", otherCurrencies, "comparison", comparison);
    }
}
