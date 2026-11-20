using System.Net;
using System.Text;
using System.Text.Json;
using DeskBridge.Agent.Core.Enrollment;
using Xunit;

namespace DeskBridge.Agent.Core.Tests.Enrollment;

public class EnrollmentClientTests
{
    private static readonly EnrollmentTarget Target =
        new(new Uri("https://relay.example/"), new Uri("wss://relay.example/ws"), "K7QM4TXP");

    private sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public HttpRequestMessage? Request { get; private set; }
        public string? Body { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Request = request;
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            return respond(request);
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static (EnrollmentClient Client, FakeHandler Handler) Make(Func<HttpRequestMessage, HttpResponseMessage> respond)
    {
        var handler = new FakeHandler(respond);
        return (new EnrollmentClient(new HttpClient(handler)), handler);
    }

    [Fact]
    public async Task Posts_code_name_and_previous_host_id_and_returns_credentials()
    {
        var (client, handler) = Make(_ => Json(HttpStatusCode.OK, """{"hostId":"pc-1234abcd","hostSecret":"s3cret"}"""));

        var result = await client.EnrollAsync(Target, "Office PC", "pc-old", CancellationToken.None);

        var ok = Assert.IsType<EnrollmentResult.Enrolled>(result);
        Assert.Equal("pc-1234abcd", ok.HostId);
        Assert.Equal("s3cret", ok.HostSecret);
        Assert.Equal(HttpMethod.Post, handler.Request!.Method);
        Assert.Equal(new Uri("https://relay.example/api/agent/enroll"), handler.Request.RequestUri);
        var body = JsonDocument.Parse(handler.Body!).RootElement;
        Assert.Equal("K7QM4TXP", body.GetProperty("code").GetString());
        Assert.Equal("Office PC", body.GetProperty("name").GetString());
        Assert.Equal("pc-old", body.GetProperty("previousHostId").GetString());
    }

    [Fact]
    public async Task Omits_previous_host_id_on_first_enrollment()
    {
        var (client, handler) = Make(_ => Json(HttpStatusCode.OK, """{"hostId":"pc-1","hostSecret":"s"}"""));
        await client.EnrollAsync(Target, "PC", null, CancellationToken.None);
        Assert.False(JsonDocument.Parse(handler.Body!).RootElement.TryGetProperty("previousHostId", out _));
    }

    [Fact]
    public async Task Rejected_code_reports_the_relay_message()
    {
        var (client, _) = Make(_ => Json(HttpStatusCode.Unauthorized, """{"error":"This enrollment code is invalid, expired or already used."}"""));
        var failed = Assert.IsType<EnrollmentResult.Failed>(await client.EnrollAsync(Target, "PC", null, CancellationToken.None));
        Assert.Equal(EnrollmentFailure.InvalidCode, failed.Kind);
        Assert.Contains("expired", failed.Message);
    }

    [Fact]
    public async Task Rate_limited()
    {
        var (client, _) = Make(_ => Json(HttpStatusCode.TooManyRequests, """{"error":"Too many failed attempts."}"""));
        var failed = Assert.IsType<EnrollmentResult.Failed>(await client.EnrollAsync(Target, "PC", null, CancellationToken.None));
        Assert.Equal(EnrollmentFailure.RateLimited, failed.Kind);
    }

    [Fact]
    public async Task Network_failure_is_unreachable()
    {
        var (client, _) = Make(_ => throw new HttpRequestException("No such host is known."));
        var failed = Assert.IsType<EnrollmentResult.Failed>(await client.EnrollAsync(Target, "PC", null, CancellationToken.None));
        Assert.Equal(EnrollmentFailure.Unreachable, failed.Kind);
        Assert.Contains("relay.example", failed.Message);
    }

    [Theory]
    [InlineData(HttpStatusCode.OK, "<html>not the relay</html>")]
    [InlineData(HttpStatusCode.OK, """{"hostId":"pc-1"}""")]
    [InlineData(HttpStatusCode.OK, """{"hostId":"bad id!","hostSecret":"s"}""")]
    [InlineData(HttpStatusCode.InternalServerError, """{"error":"boom"}""")]
    [InlineData(HttpStatusCode.NotFound, "Cannot POST")]
    public async Task Anything_else_is_an_unexpected_response(HttpStatusCode status, string body)
    {
        var (client, _) = Make(_ => new HttpResponseMessage(status) { Content = new StringContent(body) });
        var failed = Assert.IsType<EnrollmentResult.Failed>(await client.EnrollAsync(Target, "PC", null, CancellationToken.None));
        Assert.Equal(EnrollmentFailure.UnexpectedResponse, failed.Kind);
    }

    [Fact]
    public void Enrolled_result_does_not_print_the_secret()
    {
        Assert.DoesNotContain("s3cret", new EnrollmentResult.Enrolled("pc-1", "s3cret").ToString());
    }
}
