using System.Globalization;

namespace Ledger.Hidden;

public class MoneyHiddenTests
{
    [Theory]
    [InlineData("usd")]
    [InlineData("US")]
    [InlineData("USDT")]
    [InlineData("U$D")]
    [InlineData("ÜSD")]
    [InlineData("")]
    [InlineData(null)]
    public void AC_001_rejects_bad_currencies(string? currency) =>
        Assert.ThrowsAny<ArgumentException>(() => new Money(1m, currency!));

    [Theory]
    [InlineData(1.005, 1.01)]
    [InlineData(-1.005, -1.01)]
    [InlineData(2.675, 2.68)]
    [InlineData(1.004, 1.00)]
    [InlineData(10, 10)]
    public void AC_001_rounds_to_cents_away_from_zero(double input, double expected) =>
        Assert.Equal((decimal)expected, new Money((decimal)input, "USD").Amount);

    [Fact]
    public void AC_001_keeps_the_currency() => Assert.Equal("VND", new Money(5m, "VND").Currency);

    [Fact]
    public void AC_002_value_equality()
    {
        var a = new Money(1.5m, "USD");
        var b = new Money(1.50m, "USD");
        Assert.True(a == b);
        Assert.False(a != b);
        Assert.True(a.Equals(b));
        Assert.Equal(a.GetHashCode(), b.GetHashCode());
        Assert.NotEqual(a, new Money(1.5m, "EUR"));
        Assert.NotEqual(a, new Money(1.51m, "USD"));
    }

    [Fact]
    public void AC_003_adds_same_currency_only()
    {
        Assert.Equal(new Money(3.75m, "USD"), new Money(1.25m, "USD").Add(new Money(2.5m, "USD")));
        Assert.Throws<InvalidOperationException>(() => new Money(1m, "USD").Add(new Money(1m, "EUR")));
    }

    [Theory]
    [InlineData(100, new[] { 1, 1, 1 }, new[] { 33.34, 33.33, 33.33 })]
    [InlineData(0.05, new[] { 3, 7 }, new[] { 0.02, 0.03 })]
    [InlineData(10, new[] { 1 }, new[] { 10.0 })]
    [InlineData(0.01, new[] { 1, 1, 1 }, new[] { 0.01, 0, 0 })]
    [InlineData(1000, new[] { 50, 30, 20 }, new[] { 500, 300, 200.0 })]
    [InlineData(-100, new[] { 1, 1, 1 }, new[] { -33.34, -33.33, -33.33 })]
    public void AC_004_allocates_without_losing_cents(double amount, int[] ratios, double[] expected)
    {
        var whole = new Money((decimal)amount, "USD");
        var parts = whole.Allocate(ratios);
        Assert.Equal(expected.Select(e => (decimal)e), parts.Select(p => p.Amount));
        Assert.All(parts, p => Assert.Equal("USD", p.Currency));
        Assert.Equal(whole.Amount, parts.Sum(p => p.Amount));
    }

    [Theory]
    [InlineData(new int[0])]
    [InlineData(new[] { 1, -1 })]
    [InlineData(new[] { 0, 0 })]
    public void AC_004_rejects_bad_ratios(int[] ratios) =>
        Assert.ThrowsAny<ArgumentException>(() => new Money(10m, "USD").Allocate(ratios));

    [Fact]
    public void AC_005_formats_the_same_in_every_culture()
    {
        var saved = CultureInfo.CurrentCulture;
        try
        {
            foreach (var name in new[] { "en-US", "vi-VN", "de-DE", "fr-FR" })
            {
                CultureInfo.CurrentCulture = new CultureInfo(name);
                Assert.Equal("1234.50 USD", new Money(1234.5m, "USD").ToString());
                Assert.Equal("-0.10 EUR", new Money(-0.1m, "EUR").ToString());
                Assert.Equal("0.00 VND", new Money(0m, "VND").ToString());
            }
        }
        finally
        {
            CultureInfo.CurrentCulture = saved;
        }
    }
}
