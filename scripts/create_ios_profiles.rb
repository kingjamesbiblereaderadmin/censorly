#!/usr/bin/env ruby
# Creates fresh App Store distribution profiles for the iOS container app and
# Safari Web Extension, then installs them for the current Xcode build.

require "base64"
require "fileutils"
require "json"
require "net/http"
require "openssl"
require "time"
require "uri"

KEY_ID = ENV.fetch("ASC_KEY_ID")
ISSUER_ID = ENV.fetch("ASC_ISSUER_ID")
KEY_PATH = ENV.fetch("ASC_KEY_PATH")
APP_BUNDLE_ID = ENV.fetch("IOS_APP_BUNDLE_ID")
EXT_BUNDLE_ID = ENV.fetch("IOS_EXT_BUNDLE_ID")
APP_PROFILE_NAME = ENV.fetch("IOS_APP_PROFILE_NAME")
EXT_PROFILE_NAME = ENV.fetch("IOS_EXT_PROFILE_NAME")
OUTPUT_DIR = File.expand_path(ENV.fetch("IOS_PROFILE_OUTPUT_DIR"))
CERTIFICATE_SERIAL = ENV.fetch("IOS_CERTIFICATE_SERIAL").delete(":").upcase.sub(/\A0+/, "")
BASE_URL = "https://api.appstoreconnect.apple.com"

def b64url(value)
  Base64.urlsafe_encode64(value, padding: false)
end

header = b64url(JSON.generate({ alg: "ES256", kid: KEY_ID, typ: "JWT" }))
now = Time.now.to_i
payload = b64url(JSON.generate({ iss: ISSUER_ID, iat: now - 5, exp: now + 1_200, aud: "appstoreconnect-v1" }))
signing_input = "#{header}.#{payload}"
key = OpenSSL::PKey::EC.new(File.read(KEY_PATH))
der_signature = key.sign(OpenSSL::Digest::SHA256.new, signing_input)
sequence = OpenSSL::ASN1.decode(der_signature)
r = sequence.value[0].value.to_i.to_s(16).rjust(64, "0")
s = sequence.value[1].value.to_i.to_s(16).rjust(64, "0")
TOKEN = "#{signing_input}.#{b64url([r + s].pack("H*"))}"

def api(method, path, body = nil)
  uri = URI("#{BASE_URL}#{path}")
  klass = { get: Net::HTTP::Get, post: Net::HTTP::Post, delete: Net::HTTP::Delete }.fetch(method)
  request = klass.new(uri)
  request["Authorization"] = "Bearer #{TOKEN}"
  request["Content-Type"] = "application/json"
  request.body = JSON.generate(body) if body
  response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http| http.request(request) }
  unless response.code.to_i.between?(200, 299)
    raise "App Store Connect #{method.to_s.upcase} #{path} failed (HTTP #{response.code}): #{response.body}"
  end
  response.body.to_s.empty? ? {} : JSON.parse(response.body)
end

def filtered_path(resource, key, value, limit = 200)
  query = URI.encode_www_form("filter[#{key}]" => value, "limit" => limit)
  "/v1/#{resource}?#{query}"
end

def find_bundle_id(identifier)
  rows = api(:get, filtered_path("bundleIds", "identifier", identifier, 10)).fetch("data")
  row = rows.find { |item| item.dig("attributes", "identifier") == identifier }
  raise "Registered bundle ID not found: #{identifier}" unless row
  row.fetch("id")
end

def distribution_certificate
  rows = api(:get, "/v1/certificates?limit=200").fetch("data")
  accepted = %w[DISTRIBUTION IOS_DISTRIBUTION]
  now = Time.now
  candidates = rows.select do |item|
    attrs = item.fetch("attributes")
    serial = attrs.fetch("serialNumber", "").delete(":").upcase.sub(/\A0+/, "")
    accepted.include?(attrs["certificateType"]) &&
      Time.parse(attrs["expirationDate"]) > now &&
      serial == CERTIFICATE_SERIAL
  end
  raise "The installed Apple Distribution certificate was not found in App Store Connect" if candidates.empty?
  candidates.max_by { |item| Time.parse(item.dig("attributes", "expirationDate")) }.fetch("id")
end

def remove_old_profile(name)
  rows = api(:get, filtered_path("profiles", "name", name, 20)).fetch("data")
  rows.each { |item| api(:delete, "/v1/profiles/#{item.fetch("id")}") }
end

def create_profile(name, bundle_id, certificate_id, filename)
  remove_old_profile(name)
  payload = {
    data: {
      type: "profiles",
      attributes: { name: name, profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: bundle_id } },
        certificates: { data: [{ type: "certificates", id: certificate_id }] }
      }
    }
  }
  item = api(:post, "/v1/profiles", payload).fetch("data")
  content = Base64.decode64(item.dig("attributes", "profileContent"))
  raise "Apple returned an empty provisioning profile for #{name}" if content.empty?
  File.binwrite(File.join(OUTPUT_DIR, filename), content)
  puts "Installed #{name}"
end

FileUtils.mkdir_p(OUTPUT_DIR)
certificate_id = distribution_certificate
app_bundle_id = find_bundle_id(APP_BUNDLE_ID)
ext_bundle_id = find_bundle_id(EXT_BUNDLE_ID)
create_profile(APP_PROFILE_NAME, app_bundle_id, certificate_id, "Censorly-iOS.mobileprovision")
create_profile(EXT_PROFILE_NAME, ext_bundle_id, certificate_id, "CensorlyExtension-iOS.mobileprovision")
