Pod::Spec.new do |s|
  s.name = 'VarsityMediaPicker'
  s.version = '1.0.0'
  s.summary = 'Original Photos file acquisition for VarsityHub'
  s.description = s.summary
  s.license = 'MIT'
  s.author = 'VarsityHub'
  s.homepage = 'https://varsityhub.app'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/VarsityHub/VarsityHubMobile.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
