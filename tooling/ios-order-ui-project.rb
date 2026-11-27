#!/usr/bin/env ruby
require 'xcodeproj'

abort 'Usage: ios-order-ui-project.rb PROJECT_PATH' unless ARGV.size == 1
project_path = File.expand_path(ARGV.fetch(0))
source_name = 'ios-order-checkout.swift'
abort "Missing #{source_name} next to the runner project" unless File.file?(File.join(File.dirname(project_path), source_name))

project = Xcodeproj::Project.new(project_path)
target = project.new_target(:ui_test_bundle, 'CrustCaperOrderUITests', :ios, '16.0', nil, :swift)
target.source_build_phase.add_file_reference(project.main_group.new_file(source_name))
target.build_configurations.each do |config|
  config.build_settings.merge!(
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks'],
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.crustcaper.ci.order-uitests',
    'SUPPORTED_PLATFORMS' => 'iphonesimulator',
    'SWIFT_VERSION' => '5.0',
    'TARGETED_DEVICE_FAMILY' => '1'
  )
end
project.save

scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target, false)
scheme.add_test_target(target)
scheme.test_action.build_configuration = 'Release'
scheme.save_as(project_path, target.name, true)
