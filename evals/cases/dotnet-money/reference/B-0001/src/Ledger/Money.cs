using System.Globalization;

namespace Ledger;

public readonly record struct Money
{
    public decimal Amount { get; }
    public string Currency { get; }

    public Money(decimal amount, string currency)
    {
        if (currency is null || currency.Length != 3 || !currency.All(c => c is >= 'A' and <= 'Z'))
            throw new ArgumentException($"not a currency code: {currency}", nameof(currency));
        Amount = Math.Round(amount, 2, MidpointRounding.AwayFromZero);
        Currency = currency;
    }

    public Money Add(Money other)
    {
        if (other.Currency != Currency) throw new InvalidOperationException($"cannot add {other.Currency} to {Currency}");
        return new Money(Amount + other.Amount, Currency);
    }

    public Money[] Allocate(params int[] ratios)
    {
        if (ratios.Length == 0 || ratios.Any(r => r < 0) || ratios.All(r => r == 0))
            throw new ArgumentException("ratios must be non-negative and not all zero", nameof(ratios));
        var currency = Currency;
        if (Amount < 0) return new Money(-Amount, currency).Allocate(ratios).Select(m => new Money(-m.Amount, currency)).ToArray();
        var cents = (long)(Amount * 100);
        var total = ratios.Sum(r => (long)r);
        var parts = ratios.Select(r => cents * r / total).ToArray();
        for (var (i, left) = (0, cents - parts.Sum()); left > 0; i++, left--) parts[i]++;
        return parts.Select(p => new Money(p / 100m, currency)).ToArray();
    }

    public override string ToString() => $"{Amount.ToString("0.00", CultureInfo.InvariantCulture)} {Currency}";
}
