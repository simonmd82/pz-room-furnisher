using System.Runtime.InteropServices;

namespace backend.Services;

/// <summary>
/// Writes warnings and errors to logs/pzrf.log under the content root, so crash reports have
/// something to attach. Each start moves the previous log to pzrf.old.log. Logging must never
/// take the app down, so every file failure is swallowed.
/// </summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly object _lock = new();
    private StreamWriter? _writer;

    public FileLoggerProvider(string contentRoot)
    {
        try
        {
            var dir = LogDirectory(contentRoot);
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, "pzrf.log");
            if (File.Exists(path)) File.Move(path, Path.Combine(dir, "pzrf.old.log"), overwrite: true);
            _writer = new StreamWriter(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read)) { AutoFlush = true };
            Write($"PZ Room Furnisher {AppInfo.Version} on {RuntimeInformation.OSDescription}");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _writer = null;
        }
    }

    public static string LogDirectory(string contentRoot) => Path.Combine(contentRoot, "logs");

    public ILogger CreateLogger(string categoryName) => new FileLogger(this, categoryName);

    public void Dispose()
    {
        lock (_lock)
        {
            _writer?.Dispose();
            _writer = null;
        }
    }

    private void Write(string line)
    {
        lock (_lock)
        {
            try { _writer?.WriteLine($"{DateTime.UtcNow:O} {line}"); }
            catch (Exception e) when (e is IOException or ObjectDisposedException) { _writer = null; }
        }
    }

    private sealed class FileLogger(FileLoggerProvider owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning && logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
                                Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            owner.Write($"{logLevel} {category}: {formatter(state, exception)}{(exception is null ? "" : Environment.NewLine + exception)}");
        }
    }
}
