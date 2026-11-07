namespace Ledger.Tests;

public class SmokeTests
{
    [Fact]
    public void The_library_builds() => Assert.NotNull(typeof(SmokeTests).Assembly);
}
