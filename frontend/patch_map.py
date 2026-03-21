import sys

path = r'C:\Users\USER\Desktop\SWINBURNE LEARNING MATERIAL\sport_app\frontend\app\(tabs)\Map.tsx'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

content_lf = content.replace('\r\n', '\n')

start_marker = '    // Request location permissions and fetch user location\n    const hasCenteredRef'
end_marker = '    };\n\n    // Handle marker when pressed'

start_idx = content_lf.find(start_marker)
end_idx = content_lf.find(end_marker)
if start_idx == -1 or end_idx == -1:
    print('Markers not found', start_idx, end_idx)
    sys.exit(1)

end_idx += len('    };\n')

replacement = (
    '    // Center map on user location - called on every tab focus and by the My Location button\n'
    '    const handleMyLocationPress = useCallback(async () => {\n'
    '      try {\n'
    '        const { status } = await Location.requestForegroundPermissionsAsync();\n'
    '        if (status !== "granted") return;\n'
    '        const location = await Location.getCurrentPositionAsync({});\n'
    '        setUserLocation(location);\n'
    '        focusMapRegion(location.coords.latitude, location.coords.longitude, 2);\n'
    '      } catch (e) {\n'
    '        console.log("Location error:", e);\n'
    '      }\n'
    '    }, [focusMapRegion]);\n'
    '\n'
    '    // Every time the user enters the Map tab, auto-center to their location\n'
    '    useFocusEffect(useCallback(() => {\n'
    '      void handleMyLocationPress();\n'
    '    }, [handleMyLocationPress]));\n'
)

new_content = content_lf[:start_idx] + replacement + content_lf[end_idx:]
with open(path, 'w', encoding='utf-8') as f:
    f.write(new_content)
print('SUCCESS')
