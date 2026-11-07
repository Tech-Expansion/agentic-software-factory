# Money

A value type for amounts of money, in the `Ledger` class library (`src/Ledger`). Tests go in `tests/Ledger.Tests`
(xUnit) and run with `dotnet test tests/Ledger.Tests`.

## Interface

`Ledger.Money`, an immutable value type:

- `new Money(decimal amount, string currency)`
- `Amount` and `Currency` properties
- `Money Add(Money other)`
- `Money[] Allocate(params int[] ratios)`
- `ToString()`

## Acceptance criteria

- AC-001: The currency is exactly three upper-case ASCII letters ("USD", "VND"); anything else, including null,
  throws `ArgumentException`. The amount is rounded to 2 decimal places with halves away from zero: 1.005 becomes
  1.01 and -1.005 becomes -1.01.
- AC-002: Two values are equal when their amounts and currencies are equal. `==`, `!=`, `Equals` and `GetHashCode`
  agree, so 1.5 USD equals 1.50 USD.
- AC-003: `Add` returns the sum in the same currency. Adding a different currency throws
  `InvalidOperationException`.
- AC-004: `Allocate` splits the amount by the ratios without losing or creating a cent: the parts add up exactly to
  the original. Each part is its ratio's share rounded down to the cent, and the cents left over go one each to the
  first parts: 100.00 by (1, 1, 1) gives 33.34, 33.33, 33.33. A negative amount is split the same way with the sign
  reversed. No ratios, a negative ratio, or ratios that are all zero throw `ArgumentException`.
- AC-005: `ToString()` gives the amount with exactly two decimals and a "." separator whatever the current culture,
  a space, and the currency: "1234.50 USD".
