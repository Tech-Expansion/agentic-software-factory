namespace Ledger.Tests;

public class MoneyTests
{
    [Fact]
    public void AC_001_rounds_halves_away_from_zero() => Assert.Equal(1.01m, new Money(1.005m, "USD").Amount);

    [Fact]
    public void AC_004_allocates_every_cent() =>
        Assert.Equal([33.34m, 33.33m, 33.33m], new Money(100m, "USD").Allocate(1, 1, 1).Select(m => m.Amount));
}
