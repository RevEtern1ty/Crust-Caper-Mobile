#!/usr/bin/env ruby
require 'xcodeproj'

abort 'Usage: ios-checkout-signing-ci.rb PROJECT.xcodeproj SCRATCH.entitlements' unless ARGV.size == 2
project_path, entitlements_path = ARGV.map { |path| File.expand_path(path) }
unless File.extname(project_path) == '.xcodeproj' && File.file?(File.join(project_path, 'project.pbxproj'))
  abort 'Expected the generated iOS application Xcode project.'
end
unless File.extname(entitlements_path) == '.entitlements' && File.directory?(File.dirname(entitlements_path)) &&
       !File.exist?(entitlements_path) && !File.symlink?(entitlements_path)
  abort 'Expected an unused .entitlements file path in the scratch directory.'
end

project = Xcodeproj::Project.open(project_path)
applications = project.native_targets.select { |target| target.product_type == 'com.apple.product-type.application' }
abort 'Expected exactly one native iOS application target.' unless applications.one?
application = applications.first
release = application.build_configurations.find { |configuration| configuration.name == 'Release' }
bundle_id = 'com.crustcaper.mobile.local'
unless release && release.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] == bundle_id
  abort "Expected the application Release target with the literal bundle identifier #{bundle_id}."
end

simulator = '[sdk=iphonesimulator*]'
simulator_bundle_id = release.resolve_build_setting("PRODUCT_BUNDLE_IDENTIFIER#{simulator}", application)
abort 'The simulator bundle identifier differs from the local application.' if simulator_bundle_id && simulator_bundle_id != bundle_id

existing_path = release.resolve_build_setting("CODE_SIGN_ENTITLEMENTS#{simulator}", application) ||
                release.resolve_build_setting('CODE_SIGN_ENTITLEMENTS', application)
entitlements = if existing_path.nil? || existing_path.empty?
                 {}
               else
                 Xcodeproj::Plist.read_from_path(File.expand_path(existing_path, project.project_dir))
               end
abort 'Expected a dictionary in the application entitlements plist.' unless entitlements.is_a?(Hash)

# Keychain uses this identifier as the app's private access group on the isolated simulator.
entitlements['application-identifier'] = "CRUSTCAPER.#{bundle_id}"
Xcodeproj::Plist.write_to_path(entitlements, entitlements_path)

release.build_settings.merge!(
  "CODE_SIGNING_ALLOWED#{simulator}" => 'YES',
  "CODE_SIGNING_REQUIRED#{simulator}" => 'YES',
  "CODE_SIGN_STYLE#{simulator}" => 'Manual',
  "CODE_SIGN_IDENTITY#{simulator}" => '-',
  "CODE_SIGN_ENTITLEMENTS#{simulator}" => entitlements_path
)
project.save
