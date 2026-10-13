using System.Reflection;

namespace backend.Services;

public static class AppInfo
{
    /// <summary>
    /// Product version from the csproj &lt;Version&gt; (release builds override it with the git tag via
    /// -p:Version=…), without the "+commit" suffix the SDK appends to InformationalVersion.
    /// </summary>
    public static readonly string Version =
        (typeof(AppInfo).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
         ?? typeof(AppInfo).Assembly.GetName().Version?.ToString()
         ?? "unknown").Split('+')[0];
}
