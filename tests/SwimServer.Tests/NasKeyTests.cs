namespace SwimServer.Tests;

/// <summary>
/// The identity key itself. Everything in the fused index hangs off this type's equality, so a
/// defect here does not produce an error — it silently merges two aircraft into one entity, or
/// splits one into many.
///
/// <para>These exist because a mutation run found the key type almost uncovered: deleting
/// <c>Kind</c> from the equality left all 194 other tests green, and so did deleting the second
/// component. The second one is the more interesting miss — it was masked because
/// <c>GetHashCode</c> still included <c>B</c>, so the mutated keys landed in different buckets
/// and were never compared. <b>Equality and hashing have to be broken together to be visible
/// through the index</b>, which is precisely why the type needs testing directly rather than
/// only through its users.</para>
/// </summary>
public class NasKeyTests
{
    [Fact]
    public void TheKindIsPartOfTheIdentity()
    {
        // Same text, different kinds. "ABCDEF" is a valid Mode S hex and could equally be a
        // facility id or a GUFI fragment; if the kind did not count, a hex would merge with a
        // callsign and a TRACON's track with an airport's.
        Assert.NotEqual(NasKey.Hex("ABCDEF"), NasKey.Cs("ABCDEF"));
        Assert.NotEqual(NasKey.Cs("ABCDEF"), NasKey.Gufi("ABCDEF"));
        Assert.NotEqual(NasKey.Track("PCT", "0421"), NasKey.Surface("PCT", "0421"));
    }

    [Fact]
    public void TheSecondComponentIsPartOfTheIdentity()
    {
        // Without this, every track at a facility is one entity.
        Assert.NotEqual(NasKey.Track("PCT", "0421"), NasKey.Track("PCT", "0422"));
        Assert.NotEqual(NasKey.Track("PCT", "0421"), NasKey.Track("A80", "0421"));
        Assert.NotEqual(NasKey.Surface("KORD", "77"), NasKey.Surface("KORD", "78"));
    }

    /// <summary>
    /// Hashing must agree with equality, in both directions. Equal keys that hash differently
    /// never meet in a dictionary — which is exactly how a broken-equality mutation hid.
    /// </summary>
    [Fact]
    public void EqualKeysHashEqually()
    {
        Assert.Equal(NasKey.Hex("abc123").GetHashCode(), NasKey.Hex("ABC123").GetHashCode());
        Assert.Equal(NasKey.Track("pct", "0421").GetHashCode(), NasKey.Track("PCT", "0421").GetHashCode());
        Assert.Equal(NasKey.Cs("aal100"), NasKey.Cs("AAL100"));
    }

    /// <summary>
    /// Case must never split an entity. SFDPS publishes Mode S hex lower-case
    /// (<c>-AD9003</c> in supplementalData) while TAIS publishes it upper-case, so an
    /// ordinal comparison would stop the two sources ever joining on the strongest key there
    /// is — and the only symptom would be the same aeroplane drawn twice.
    /// </summary>
    [Theory]
    [InlineData("ad9003", "AD9003")]
    [InlineData("AbCdEf", "aBcDeF")]
    public void CaseNeverSplitsAnEntity(string a, string b)
    {
        Assert.Equal(NasKey.Hex(a), NasKey.Hex(b));
        var d = new Dictionary<NasKey, int> { [NasKey.Hex(a)] = 1 };
        Assert.True(d.ContainsKey(NasKey.Hex(b)));
    }

    /// <summary>A one-part key and a two-part key with a null second half are not interchangeable
    /// with anything, and a null B must not throw.</summary>
    [Fact]
    public void AMissingSecondComponentIsHandled()
    {
        Assert.Equal(NasKey.Hex("abc"), NasKey.Hex("abc"));
        Assert.NotEqual(NasKey.Hex("abc"), NasKey.Track("abc", "1"));
        _ = NasKey.Hex("abc").GetHashCode();
    }

    /// <summary>Usable as a dictionary key without boxing on every lookup — the index does
    /// ~100,000 of them a pass.</summary>
    [Fact]
    public void ItIsAnIEquatableValueType()
    {
        Assert.True(typeof(NasKey).IsValueType);
        Assert.True(typeof(IEquatable<NasKey>).IsAssignableFrom(typeof(NasKey)));
    }
}
