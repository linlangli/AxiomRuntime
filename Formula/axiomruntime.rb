class Axiomruntime < Formula
  desc "CLI-first enterprise AI Runtime with governed provider routing"
  homepage "https://gitlab.com/linlangli/agent-router"
  url "https://registry.npmjs.org/@offerpilot/axiomruntime/-/axiomruntime-0.0.1.tgz"
  sha256 "b31cbfb456207b8958df4e79c2384598dba98cdf9c696e4751b842a481c3ea8e"

  depends_on "python@3.13" => :build
  depends_on "node@22"

  def install
    args = std_npm_args(ignore_scripts: false)
    ENV.prepend_path "PATH", Formula["node@22"].opt_bin
    system Formula["node@22"].opt_bin/"npm", "install", *args

    entrypoint = libexec/"lib/node_modules/@offerpilot/axiomruntime/dist/cli/index.js"
    inreplace entrypoint, "#!/usr/bin/env node", "#!#{Formula["node@22"].opt_bin}/node"
    bin.install_symlink libexec/"bin/ai"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/ai --version").strip
  end
end
