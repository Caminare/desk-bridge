using System.Buffers;
using System.Globalization;

namespace DeskBridge.Agent.Core.Protocol;

/// <summary>
/// Minimal JSON writer that reproduces <c>JSON.stringify</c> byte for byte for the value kinds a frame
/// header uses. System.Text.Json cannot be used for this: even with relaxed escaping it escapes astral
/// characters (emoji) and DEL, uses uppercase hex in \u escapes, and its number formatting differs from
/// ECMAScript Number::toString (exponent thresholds, "E+20" style).
/// Matching JS: NaN and infinities are written as null, -0 as 0, lone surrogates as lowercase \udXXX
/// (well-formed JSON.stringify). No known character class differs from JS.
/// </summary>
internal ref struct JsJson
{
    private const string Hex = "0123456789abcdef";
    private readonly ArrayBufferWriter<byte> _buf;
    private bool _needComma;
    private bool _outerNeedComma;

    public JsJson(ArrayBufferWriter<byte> buf)
    {
        _buf = buf;
        _needComma = false;
        _outerNeedComma = false;
    }

    public void BeginObject()
    {
        Raw((byte)'{');
        _needComma = false;
    }

    public void EndObject()
    {
        Raw((byte)'}');
        _needComma = true;
    }

    /// <summary>Writes <c>"name":{</c> and starts a nested object; <see cref="EndNested"/> closes it.</summary>
    public void BeginNested(ReadOnlySpan<byte> name)
    {
        Name(name);
        Raw((byte)'{');
        _outerNeedComma = true;
        _needComma = false;
    }

    public void EndNested()
    {
        Raw((byte)'}');
        _needComma = _outerNeedComma;
    }

    public void Str(ReadOnlySpan<byte> name, string? value)
    {
        if (value is null) return;
        Name(name);
        WriteString(value);
    }

    public void Num(ReadOnlySpan<byte> name, double? value)
    {
        if (value is null) return;
        Name(name);
        WriteNumber(value.Value);
    }

    public void Bool(ReadOnlySpan<byte> name, bool? value)
    {
        if (value is null) return;
        Name(name);
        Raw(value.Value ? "true"u8 : "false"u8);
    }

    public void BeginArray(ReadOnlySpan<byte> name)
    {
        Name(name);
        Raw((byte)'[');
        _needComma = false;
    }

    public void ArrayInt(long value)
    {
        if (_needComma) Raw((byte)',');
        _needComma = true;
        WriteInteger(value);
    }

    public void ArrayNumber(double value)
    {
        if (_needComma) Raw((byte)',');
        _needComma = true;
        WriteNumber(value);
    }

    public void EndArray()
    {
        Raw((byte)']');
        _needComma = true;
    }

    private void Name(ReadOnlySpan<byte> name)
    {
        if (_needComma) Raw((byte)',');
        _needComma = true;
        Raw((byte)'"');
        Raw(name);
        Raw((byte)'"');
        Raw((byte)':');
    }

    private void Raw(byte b)
    {
        _buf.GetSpan(1)[0] = b;
        _buf.Advance(1);
    }

    private void Raw(ReadOnlySpan<byte> bytes)
    {
        bytes.CopyTo(_buf.GetSpan(bytes.Length));
        _buf.Advance(bytes.Length);
    }

    private void WriteInteger(long value)
    {
        value.TryFormat(_buf.GetSpan(24), out int n, default, CultureInfo.InvariantCulture);
        _buf.Advance(n);
    }

    private void WriteString(string s)
    {
        // Worst case is 6 bytes per UTF-16 unit (\uXXXX); real text is 1 to 3.
        Span<byte> dst = _buf.GetSpan((s.Length * 6) + 2);
        int p = 0;
        dst[p++] = (byte)'"';
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '"') { dst[p++] = (byte)'\\'; dst[p++] = (byte)'"'; }
            else if (c == '\\') { dst[p++] = (byte)'\\'; dst[p++] = (byte)'\\'; }
            else if (c < 0x20)
            {
                dst[p++] = (byte)'\\';
                switch (c)
                {
                    case '\b': dst[p++] = (byte)'b'; break;
                    case '\f': dst[p++] = (byte)'f'; break;
                    case '\n': dst[p++] = (byte)'n'; break;
                    case '\r': dst[p++] = (byte)'r'; break;
                    case '\t': dst[p++] = (byte)'t'; break;
                    default:
                        dst[p++] = (byte)'u';
                        dst[p++] = (byte)'0';
                        dst[p++] = (byte)'0';
                        dst[p++] = (byte)Hex[c >> 4];
                        dst[p++] = (byte)Hex[c & 0xf];
                        break;
                }
            }
            else if (c < 0x80) dst[p++] = (byte)c;
            else if (c < 0x800)
            {
                dst[p++] = (byte)(0xC0 | (c >> 6));
                dst[p++] = (byte)(0x80 | (c & 0x3F));
            }
            else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
            {
                int cp = char.ConvertToUtf32(c, s[++i]);
                dst[p++] = (byte)(0xF0 | (cp >> 18));
                dst[p++] = (byte)(0x80 | ((cp >> 12) & 0x3F));
                dst[p++] = (byte)(0x80 | ((cp >> 6) & 0x3F));
                dst[p++] = (byte)(0x80 | (cp & 0x3F));
            }
            else if (char.IsSurrogate(c))
            {
                dst[p++] = (byte)'\\';
                dst[p++] = (byte)'u';
                dst[p++] = (byte)Hex[c >> 12];
                dst[p++] = (byte)Hex[(c >> 8) & 0xf];
                dst[p++] = (byte)Hex[(c >> 4) & 0xf];
                dst[p++] = (byte)Hex[c & 0xf];
            }
            else
            {
                dst[p++] = (byte)(0xE0 | (c >> 12));
                dst[p++] = (byte)(0x80 | ((c >> 6) & 0x3F));
                dst[p++] = (byte)(0x80 | (c & 0x3F));
            }
        }
        dst[p++] = (byte)'"';
        _buf.Advance(p);
    }

    private void WriteNumber(double v)
    {
        if (!double.IsFinite(v)) { Raw("null"u8); return; }
        if (v == 0) { Raw((byte)'0'); return; }
        if (Math.Abs(v) < 1e15 && v == Math.Floor(v)) { WriteInteger((long)v); return; }
        int n = FormatEcma(v, _buf.GetSpan(64));
        _buf.Advance(n);
    }

    /// <summary>ECMAScript Number::toString(v) for a finite, non-zero double. Returns the byte count.</summary>
    internal static int FormatEcma(double v, Span<byte> dst)
    {
        // .NET "R" gives the shortest round-trip digits; only the layout differs from JS.
        Span<byte> tmp = stackalloc byte[40];
        v.TryFormat(tmp, out int len, "R", CultureInfo.InvariantCulture);

        int idx = 0;
        bool neg = tmp[0] == (byte)'-';
        if (neg) idx = 1;
        Span<byte> digits = stackalloc byte[32];
        int dc = 0;
        int point = -1;
        int exp = 0;
        for (; idx < len; idx++)
        {
            byte b = tmp[idx];
            if (b == (byte)'.') point = dc;
            else if (b == (byte)'E' || b == (byte)'e')
            {
                int j = idx + 1;
                bool eneg = false;
                if (tmp[j] == (byte)'+') j++;
                else if (tmp[j] == (byte)'-') { eneg = true; j++; }
                for (; j < len; j++) exp = (exp * 10) + (tmp[j] - '0');
                if (eneg) exp = -exp;
                break;
            }
            else digits[dc++] = b;
        }
        if (point < 0) point = dc;
        int n = point + exp; // value = 0.DIGITS x 10^n

        int lead = 0;
        while (lead < dc - 1 && digits[lead] == (byte)'0') lead++;
        digits = digits.Slice(lead, dc - lead);
        n -= lead;
        dc -= lead;
        while (dc > 1 && digits[dc - 1] == (byte)'0') dc--;
        int k = dc;

        int p = 0;
        if (neg) dst[p++] = (byte)'-';
        if (k <= n && n <= 21)
        {
            digits[..k].CopyTo(dst[p..]);
            p += k;
            for (int z = 0; z < n - k; z++) dst[p++] = (byte)'0';
        }
        else if (0 < n && n <= 21)
        {
            digits[..n].CopyTo(dst[p..]);
            p += n;
            dst[p++] = (byte)'.';
            digits[n..k].CopyTo(dst[p..]);
            p += k - n;
        }
        else if (-6 < n && n <= 0)
        {
            dst[p++] = (byte)'0';
            dst[p++] = (byte)'.';
            for (int z = 0; z < -n; z++) dst[p++] = (byte)'0';
            digits[..k].CopyTo(dst[p..]);
            p += k;
        }
        else
        {
            int e = n - 1;
            dst[p++] = digits[0];
            if (k > 1)
            {
                dst[p++] = (byte)'.';
                digits[1..k].CopyTo(dst[p..]);
                p += k - 1;
            }
            dst[p++] = (byte)'e';
            dst[p++] = e < 0 ? (byte)'-' : (byte)'+';
            Math.Abs(e).TryFormat(dst[p..], out int written, default, CultureInfo.InvariantCulture);
            p += written;
        }
        return p;
    }
}
