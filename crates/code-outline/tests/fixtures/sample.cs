using System;

namespace Demo;

/// <summary>A store.</summary>
[Serializable]
public class Store
{
    public Store() { }

    public int Add(int a, int b) { return a + b; }
    public double Add(double a, double b) { return a + b; }

    public string Name { get; set; }

    public class Nested
    {
    }
}

public record Person(string Name);

public struct Pt { }

public interface IThing
{
    void Go();
}

public enum Mode { A, B }
